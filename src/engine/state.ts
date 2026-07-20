import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { Store, Doc } from '../store/store.ts';
import type { EntityContext } from '../entities/types.ts';
import { checksum } from '../checksum.ts';
import { buildDocs } from './apply.ts';
import { buildSources } from './build.ts';
import { planAgainstServer } from './plan.ts';
import { validateAll } from './validate.ts';
import { entityByKind } from '../entities/index.ts';

export type Action = 'create' | 'update' | 'noop' | 'delete';
export interface Resource {
  kind: string; localId: string; name: string; action: Action;
  fromChecksum: string | null; toChecksum: string | null;
  nodes?: { name: string; status: string }[];
  setActive?: boolean; // workflows: activate/deactivate to reach the desired state
}
// An entity that still exists in the DB / on n8n but has no file — planned as a
// delete only with --destroy, otherwise reported so `plan` never hides it.
export interface Orphan { kind: string; localId: string; name: string; }
export interface State {
  env: string; n8cVersion: string; createdAt: string;
  desiredChecksum: string;
  summary: { create: number; update: number; noop: number; delete: number };
  resources: Resource[];
  orphans?: Orphan[];
  applied: { at: string; ok: string[]; failed: { localId: string; error: string }[] } | null;
}

// Terraform-style state file, per env, mirroring the .env naming (env.ts):
// default → .states/n8c.state.json; named → .states/n8c.state.<env>.json.
export function statePath(cwd: string, env: string): string {
  const name = !env || env === 'default' ? 'n8c.state.json' : `n8c.state.${env}.json`;
  return join(cwd, '.states', name);
}
export function writeState(cwd: string, env: string, state: State): string {
  const file = statePath(cwd, env);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(state, null, 2) + '\n');
  return file;
}
export function readState(cwd: string, env: string): State {
  const file = statePath(cwd, env);
  if (!existsSync(file)) throw new Error(`no plan for env "${env}" — run \`n8c plan\` first (${file} not found)`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

const ORDER = ['credentials', 'prompts', 'promptContents', 'workflows'];

// The kinds this store/env actually processes. promptContents is Mongo-only —
// skip it when the active store doesn't serve it (e.g. sqlite). Undefined means
// enabled (backward compatible with hand-built contexts in tests).
export function activeKinds(ctx: EntityContext): string[] {
  return ctx.promptContentsEnabled === false ? ORDER.filter((k) => k !== 'promptContents') : ORDER;
}

// Bundle checksum over ALL desired docs (every kind) — the staleness guard: apply
// refuses to run if the files changed since plan.
export async function desiredBundleChecksum(root: string, ctx: EntityContext): Promise<string> {
  const codeByNode = (await buildSources(dirname(root))).codeByNode;
  const parts: string[] = [];
  for (const kind of activeKinds(ctx)) {
    const docs = await buildDocs(entityByKind[kind], root, ctx, kind === 'workflows' ? codeByNode : {});
    for (const d of docs) parts.push(`${kind}:${d.localId}:${d.checksum}`);
  }
  return checksum(parts.sort());
}

function statusToAction(status: string): Action {
  return status === 'new' ? 'create' : status === 'removed' ? 'delete' : status === 'identical' ? 'noop' : 'update';
}

// Compute the plan: desired (files) vs live. Workflows AND credentials diff
// against the LIVE n8n server; prompts diff against the DB live docs (not
// server-backed).
export async function computePlan(store: Store, root: string, ctx: EntityContext, opts: { destroy?: boolean; version: string } ): Promise<State> {
  const problems = await validateAll(root, ctx, store);
  if (problems.length) throw new Error(`validation failed (${problems.length}):\n` + problems.map((p) => '  • ' + p).join('\n'));

  const codeByNode = (await buildSources(dirname(root))).codeByNode;
  const resources: Resource[] = [];

  // prompts + promptContents: DB-live diff (no n8n). prompts = build-time prompts;
  // promptContents = runtime docs the load_prompts node reads (Mongo-only — dropped
  // by activeKinds when the store doesn't serve it). Both are DB-only.
  // Entities that exist in the DB/on n8n but no longer have a file — i.e. you
  // deleted the directory. Deletes are only PLANNED with --destroy (the instance is
  // shared); without it they're collected as `orphans` so the plan can still say
  // they exist instead of silently ignoring them.
  const orphans: Orphan[] = [];

  for (const dbKind of activeKinds(ctx).filter((k) => k === 'prompts' || k === 'promptContents')) {
    const desired = await buildDocs(entityByKind[dbKind], root, ctx);
    const liveById = new Map((await store.getLive(dbKind)).map((d) => [d.localId, d]));
    for (const d of desired) {
      const prev = liveById.get(d.localId);
      const action: Action = !prev ? 'create' : prev.checksum === d.checksum ? 'noop' : 'update';
      resources.push({ kind: dbKind, localId: d.localId, name: d.name, action, fromChecksum: prev?.checksum ?? null, toChecksum: d.checksum });
    }
    const desiredIds = new Set(desired.map((d) => d.localId));
    for (const [localId, live] of liveById) {
      if (desiredIds.has(localId)) continue;
      if (!opts.destroy) { orphans.push({ kind: dbKind, localId, name: live.name }); continue; }
      resources.push({ kind: dbKind, localId, name: live.name, action: 'delete', fromChecksum: live.checksum, toChecksum: null });
    }
  }

  // credentials: diff desired files vs the LIVE n8n credentials. n8n's API (1.1.x)
  // returns id/name/type + updatedAt (no secrets) and supports PATCH, so we
  // reconcile in place (no duplicate POSTs). Signals:
  //   mapped id gone on server → create (recreate + rebind)
  //   updatedAt drift (edited on n8n) OR name/type drift OR file changed vs live → update (PATCH)
  //   else → noop; unmapped → create.
  // If we can't list (key isn't owner/admin, or the call fails) fall back to
  // file-vs-live only so a failed list never triggers a mass-recreate.
  {
    const credDefs = await ctx.getDefinitions('credentials');
    const liveById = new Map((await store.getLive('credentials')).map((d) => [d.localId, d]));
    const serverById = new Map<string, any>();
    let listed = false;
    if (ctx.n8n && (ctx.n8n as any).listCredentials) {
      try { for (const c of await ctx.n8n.listCredentials()) serverById.set(String(c.id), c); listed = true; } catch { /* no list permission */ }
    }
    const desired = await buildDocs(entityByKind['credentials'], root, ctx);
    for (const d of desired) {
      const body = d.body as any;
      const mapped = credDefs[d.localId] as { id: string; name: string; updatedAt?: string } | undefined;
      const prev = liveById.get(d.localId);
      // A credential's secret can never be read back from n8n, so the ONLY baseline
      // for the file's content is the live doc written by a previous apply. With no
      // live doc we cannot prove the file matches what's deployed — treat it as an
      // update rather than silently skipping a real edit (the exact trap: editing
      // `data` on a pulled-but-never-applied credential showed "no changes").
      const fileChanged = prev === undefined || prev.checksum !== d.checksum;
      let action: Action;
      if (!mapped) action = 'create';
      else if (listed) {
        const server = serverById.get(String(mapped.id));
        if (!server) action = 'create';
        else {
          const nameTypeDrift = server.name !== body.name || String(server.type) !== String(body.type);
          const externalEdit = mapped.updatedAt !== undefined && String(server.updatedAt) !== String(mapped.updatedAt);
          action = (nameTypeDrift || externalEdit || fileChanged) ? 'update' : 'noop';
        }
      } else {
        action = fileChanged ? 'update' : 'noop';
      }
      resources.push({ kind: 'credentials', localId: d.localId, name: d.name, action, fromChecksum: prev?.checksum ?? null, toChecksum: d.checksum });
    }
    // A credential is "known" if it has a live doc OR an env mapping; either way,
    // no file means you deleted it.
    const desiredIds = new Set(desired.map((d) => d.localId));
    for (const localId of new Set([...liveById.keys(), ...Object.keys(credDefs)])) {
      if (desiredIds.has(localId)) continue;
      const name = liveById.get(localId)?.name ?? (credDefs[localId] as any)?.name ?? localId;
      if (!opts.destroy) { orphans.push({ kind: 'credentials', localId, name }); continue; }
      resources.push({ kind: 'credentials', localId, name, action: 'delete', fromChecksum: liveById.get(localId)?.checksum ?? null, toChecksum: null });
    }
  }

  // workflows: diff desired files vs the live n8n server
  const rows = await planAgainstServer(store, entityByKind['workflows'], root, ctx);
  for (const r of rows) {
    const action = statusToAction(r.status);
    // never delete implicitly on a shared instance — report it as an orphan instead
    if (action === 'delete' && !opts.destroy) { orphans.push({ kind: 'workflows', localId: r.localId, name: r.name }); continue; }
    resources.push({
      kind: 'workflows', localId: r.localId, name: r.name, action,
      fromChecksum: action === 'create' ? null : (r.checksum || null),
      toChecksum: action === 'delete' ? null : (r.checksum || null),
      nodes: (r.nodes ?? []).filter((n: any) => n.status !== 'identical').map((n: any) => ({ name: n.name, status: n.status })),
      setActive: r.setActive,
    });
  }

  const summary = { create: 0, update: 0, noop: 0, delete: 0 };
  for (const r of resources) summary[r.action]++;
  return {
    env: ctx.env, n8cVersion: opts.version, createdAt: new Date().toISOString(),
    desiredChecksum: await desiredBundleChecksum(root, ctx),
    summary, resources, orphans, applied: null,
  };
}

// The desired doc bodies for a kind, indexed by localId (rebuilt from files).
export async function desiredByKind(root: string, ctx: EntityContext, kind: string, codeByNode: Record<string, string>): Promise<Map<string, Doc>> {
  const docs = await buildDocs(entityByKind[kind], root, ctx, kind === 'workflows' ? codeByNode : {});
  return new Map(docs.map((d) => [d.localId, d]));
}

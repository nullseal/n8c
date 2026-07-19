import type { Store, Doc } from '../store/store.ts';
import type { EntityDescriptor, EntityContext } from '../entities/types.ts';
import { dirname } from 'node:path';
import { checksum } from '../checksum.ts';
import { readEntity, listEntityIds } from '../layout.ts';
import { nextVersionId } from '../version.ts';
import { buildSources } from './build.ts';

type NodeRow = { id: string; name: string; checksum: string; status: 'identical' | 'changed' | 'new' | 'removed' };
type PlanRow = { localId: string; status: 'identical' | 'changed' | 'new'; checksum: string; nodes?: NodeRow[] };

// Per-node diff of a workflow body against its previous live body (match by
// node id, else name). Node checksum ignores volatile fields (incl. id).
export function diffNodes(desiredBody: any, liveBody: any): NodeRow[] {
  const key = (n: any) => n?.id ?? n?.name;
  const live = new Map<string, string>();
  for (const n of liveBody?.nodes ?? []) live.set(key(n), checksum(n));
  const rows: NodeRow[] = [];
  const seen = new Set<string>();
  for (const n of desiredBody?.nodes ?? []) {
    const k = key(n); seen.add(k);
    const h = checksum(n);
    const prev = live.get(k);
    rows.push({ id: n?.id ?? k, name: n?.name ?? k, checksum: h, status: prev === undefined ? 'new' : prev === h ? 'identical' : 'changed' });
  }
  for (const n of liveBody?.nodes ?? []) if (!seen.has(key(n))) rows.push({ id: n?.id ?? key(n), name: n?.name ?? key(n), checksum: checksum(n), status: 'removed' });
  return rows;
}

// Build the desired Doc[] from disk. The checksum is taken over the PLAINTEXT
// body (identity = the content the user wrote), while the stored body runs
// through beforeSave (e.g. credential encryption). This keeps identity stable
// even though encryption is non-deterministic (random salt/IV per call).
export async function buildDocs(desc: EntityDescriptor, root: string, ctx: EntityContext, codeByNode: Record<string, string> = {}): Promise<Doc[]> {
  const ids = listEntityIds(root, desc.kind);
  const docs: Doc[] = [];
  for (const localId of ids) {
    const { metadata, body } = await readEntity(root, desc.kind, localId, codeByNode);
    const sum = checksum(body);
    const saved = desc.beforeSave ? desc.beforeSave(ctx, body) : body;
    docs.push({ localId, name: metadata.name ?? localId, body: saved, checksum: sum });
  }
  return docs;
}

function computePlan(desired: Doc[], live: Doc[], kind: string): PlanRow[] {
  const liveById = new Map(live.map((d) => [d.localId, d]));
  return desired.map((d) => {
    const prev = liveById.get(d.localId);
    const status = !prev ? 'new' : prev.checksum === d.checksum ? 'identical' : 'changed';
    const row: PlanRow = { localId: d.localId, status, checksum: d.checksum };
    if (kind === 'workflows' && status !== 'identical') row.nodes = diffNodes(d.body, prev?.body);
    return row;
  });
}

export async function planApply(store: Store, desc: EntityDescriptor, root: string, ctx: EntityContext): Promise<PlanRow[]> {
  const desired = await buildDocs(desc, root, ctx);
  return computePlan(desired, await store.getLive(desc.kind), desc.kind);
}

export async function applyEntity(
  store: Store, desc: EntityDescriptor, root: string, ctx: EntityContext, opts: { dry: boolean; message?: string; draft?: boolean },
): Promise<{ plan: PlanRow[]; bundleChecksum: string; versionId?: string; draft?: boolean }> {
  // For workflows, build source units (src/* → dist/) and inject the resulting
  // jsCode into the targeted nodes. cwd is the parent of the n8c root.
  const codeByNode = desc.kind === 'workflows' ? (await buildSources(dirname(root))).codeByNode : {};
  const desired = await buildDocs(desc, root, ctx, codeByNode);
  const plan = computePlan(desired, await store.getLive(desc.kind), desc.kind);
  const bundleChecksum = checksum(desired.map((d) => d.checksum).sort());
  // collectExtra runs even on --dry so its validation (e.g. duplicate prompt
  // keys) is enforced; the writes below are still skipped on --dry.
  const extras = desc.collectExtra ? await desc.collectExtra(root, ctx) : [];
  if (opts.dry) return { plan, bundleChecksum };

  const versions = await store.listVersions(desc.kind);
  // Draft snapshots never count toward dedup — a later real apply must still
  // publish (putLive + markActive) even if a matching draft was captured.
  const nonDraft = versions.filter((v) => !v.draft);
  const newest = nonDraft[nonDraft.length - 1];
  const isDup = newest && newest.checksum === bundleChecksum;
  let versionId: string | undefined;
  let serverDefs: Record<string, unknown> = {};

  if (opts.draft) {
    // Draft: capture a snapshot for UI preview but do NOT publish — no putLive,
    // no markActive, and always snapshot (bypass the newest-checksum dedup).
    versionId = nextVersionId();
    await store.withTransaction((session) =>
      store.createSnapshot(desc.kind, versionId!, desired, bundleChecksum, session, opts.message, true));
  } else {
    await store.withTransaction(async (session) => {
      await store.putLive(desc.kind, desired, session);
      if (!isDup) {
        versionId = nextVersionId();
        await store.createSnapshot(desc.kind, versionId, desired, bundleChecksum, session, opts.message);
        await store.markActive(desc.kind, versionId, session);
      } else {
        // Content matches an existing version (e.g. the snapshot a pull made):
        // no new version, but live now IS that content → make it active so
        // live and the active pointer stay coherent.
        versionId = newest!.versionId;
        await store.markActive(desc.kind, versionId, session);
      }
      // Prompts extracted from workflow nodes become live prompt docs. They are
      // NOT server-backed and not resolved via an n8n id, so no definition
      // mapping is written for them (a bogus one would only pollute the env map).
      for (const g of extras) await store.upsertLive(g.kind, g.docs, session);
    });
  }

  // Draft never touches n8n; a real apply pushes. status lets the impl skip
  // redundant server writes (no duplicate credentials on unchanged applies).
  if (!opts.draft && desc.hasServer && ctx.n8n && desc.pushToServer) {
    const status: Record<string, string> = {};
    for (const row of plan) status[row.localId] = row.status;
    serverDefs = await desc.pushToServer(ctx, desired as any, status);
    if (Object.keys(serverDefs).length) {
      await store.withTransaction((session) => store.putDefinitions(ctx.env, desc.kind, serverDefs, session));
    }
  }
  return { plan, bundleChecksum, versionId, draft: opts.draft || undefined };
}

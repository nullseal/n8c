import { dirname } from 'node:path';
import type { Store } from '../store/store.ts';
import type { EntityContext } from '../entities/types.ts';
import { checksum } from '../checksum.ts';
import { nextVersionId } from '../version.ts';
import { buildSources } from './build.ts';
import { entityByKind } from '../entities/index.ts';
import { desiredByKind, activeKinds, type State, type Resource } from './state.ts';

// The rows a run executes: the plan's changes, minus the ones an earlier run of the
// same saved plan already carried out (stamped `appliedAt`).
function pendingRows(state: State, kind: string): Resource[] {
  return state.resources.filter((r) => r.kind === kind && r.action !== 'noop' && !r.appliedAt);
}

// Execute a saved plan. Per resource: PUSH to n8n FIRST, then commit the DB live
// doc — so a failed push never leaves the DB claiming "deployed" (the exact trap:
// Mongo committed, PUT 400, apply then saw "identical" and skipped forever).
//
// A saved plan applies each row at most once. Success stamps the row's `appliedAt`,
// and running the same plan again (`n8c apply` after a partial failure) skips the
// stamped rows. Re-running one is not harmless: a credential `create` POSTs a
// duplicate (status `new` creates even though the first attempt's mapping is there),
// and a workflow would be re-PUT, which republishes it. The drift gate still covers the
// stamped rows' entities, so a retry stops if one of them changed on n8n since.
//
// One apply = one RELEASE. If the apply changed anything, EVERY kind is snapshotted
// under a single shared `generation` versionId (no dedup) and marked active — so the
// version timelines stay aligned across kinds and `restore <generation>` rolls back
// all kinds to one coherent point (see cli restore). Kinds with no live docs are
// skipped (nothing to snapshot).
export async function applyFromState(store: Store, root: string, ctx: EntityContext, state: State, opts: { message?: string } = {}): Promise<State> {
  // Credentials and workflows can only be deployed to n8n. Without a client (e.g.
  // N8N_BASE unset when applying a plan saved with it), refuse BEFORE any write:
  // skipping their pushes while still committing live docs, mappings and a release
  // would record a deploy that never happened — and a skipped credential delete
  // would drop the mapping of a credential that is still on n8n. Rows that need no
  // server (prompts, noop rows, rows an earlier attempt applied) do not block.
  if (!ctx.n8n) {
    const serverRows = activeKinds(ctx).filter((k) => entityByKind[k].hasServer).flatMap((k) => pendingRows(state, k));
    if (serverRows.length) {
      const kinds = [...new Set(serverRows.map((r) => r.kind))].join(' and ');
      throw new Error(`apply needs an n8n connection (set N8N_BASE + N8N_API_KEY): ${serverRows.length} change(s) to ${kinds} must be deployed to n8n. Nothing was applied.`);
    }
  }
  const applied: State['applied'] = { at: new Date().toISOString(), ok: [], failed: [] };
  const codeByNode = (await buildSources(dirname(root))).codeByNode;
  const generation = nextVersionId(); // shared release id for every kind in THIS apply
  let anyChange = false;

  // Pass 1: push changes + commit live docs, per kind.
  for (const kind of activeKinds(ctx)) {
    const desc = entityByKind[kind];
    const rows = pendingRows(state, kind);
    if (!rows.length) continue;
    const desired = await desiredByKind(root, ctx, kind, codeByNode);
    let mapping: Record<string, unknown> = { ...(await ctx.getDefinitions(kind)) };
    let changed = false;

    for (const r of rows) {
      try {
        if (r.action === 'delete') {
          const mapped = mapping[r.localId] as any;
          // workflows: ARCHIVE (soft, recoverable via unarchive) rather than
          // hard-delete on a shared instance. credentials: mapping holds {id,name},
          // so delete by .id. DB-only kinds (prompts/prompt-content) touch no server.
          //
          // A workflow's id comes from this env's mapping when there is one, else from
          // the id `plan` read off the server. Mapping-only was a silent no-op for the
          // two cases that matter most: a workflow created in the n8n UI (never mapped),
          // and one an earlier destroy already archived (which drops the mapping while
          // n8n still lists it). Both were reported "applied" while n8n was never
          // called, so the orphan returned on every subsequent plan.
          const n8nId = kind === 'workflows'
            ? (mapped !== undefined ? String(mapped) : r.serverId)
            : kind === 'credentials' && mapped !== undefined ? String(mapped?.id ?? mapped) : undefined;
          // Only server-backed kinds resolve an id, and the guard above made sure
          // those have a client.
          if (n8nId) {
            try {
              if (kind === 'workflows') {
                // A live workflow soft-deletes (archive, recoverable via unarchive).
                // An already-archived one can't be archived again, so hard-delete it.
                if (r.archived) await ctx.n8n!.deleteWorkflow(n8nId);
                else await ctx.n8n!.archiveWorkflow(n8nId);
              } else await ctx.n8n!.deleteCredential?.(n8nId);
            } catch (e: any) {
              // Already gone on n8n (deleted here earlier, or by hand) — deleting is
              // idempotent, so a 404 means the desired end state is already true.
              if (!String(e?.message ?? e).includes('404')) throw e;
            }
          }
          delete mapping[r.localId];
          const remaining = (await store.getLive(kind)).filter((d) => d.localId !== r.localId);
          await store.withTransaction((s) => store.putLive(kind, remaining, s));
          applied.ok.push(r.localId); r.appliedAt = applied.at; changed = true;
          continue;
        }
        const d = desired.get(r.localId);
        if (!d) { applied.failed.push({ localId: r.localId, error: 'desired doc missing (files changed?)' }); continue; }
        // 1) push to n8n first (server-backed kinds; the guard above ensured a client)
        if (desc.hasServer && desc.pushToServer) {
          const m = await desc.pushToServer(ctx, [d] as any, { [d.localId]: r.action === 'create' ? 'new' : 'changed' });
          mapping = { ...mapping, ...m };
        }
        // 1b) reconcile the active flag (workflows) — the workflow body can't set
        // `active` (read-only), so activate/deactivate explicitly when it drifts.
        if (kind === 'workflows' && r.setActive !== undefined) {
          const n8nId = String(mapping[r.localId]);
          await (r.setActive ? ctx.n8n!.activateWorkflow(n8nId) : ctx.n8n!.deactivateWorkflow(n8nId));
        }
        // 2) only after a successful push, commit the live doc
        await store.withTransaction((s) => store.upsertLive(kind, [d], s));
        applied.ok.push(r.localId); r.appliedAt = applied.at; changed = true;
      } catch (e: any) {
        applied.failed.push({ localId: r.localId, error: String(e?.message ?? e) });
      }
    }

    if (changed) {
      await store.withTransaction((s) => store.putDefinitions(ctx.env, kind, mapping, s));
      anyChange = true;
    }
  }

  // Pass 2: bump ALL kinds to the shared generation (one coherent release). Skipped
  // entirely when the apply changed nothing (no empty releases).
  if (anyChange) {
    for (const kind of activeKinds(ctx)) {
      const live = await store.getLive(kind);
      if (!live.length) continue;
      const bundle = checksum(live.map((d) => d.checksum).sort());
      await store.withTransaction(async (s) => {
        await store.createSnapshot(kind, generation, live, bundle, s, opts.message);
        await store.markActive(kind, generation, s);
      });
    }
  }
  state.applied = applied;
  return state;
}

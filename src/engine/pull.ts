import type { Store, Doc, Session } from '../store/store.ts';
import type { EntityDescriptor, EntityContext } from '../entities/types.ts';
import { checksum } from '../checksum.ts';

export interface PullResult { kind: string; count: number; checksum: string; docs: Doc[]; }

// Fetch one kind's current reality — from the n8n server for server-backed kinds,
// else from the DB live docs. Records the per-env localId→n8nId mapping (ids stay
// stable across envs/re-pulls) but writes NO version: versioning is generation-wide
// and committed once by commitPullGeneration, so every kind of a pull shares one id.
export async function pullEntity(
  store: Store, desc: EntityDescriptor, _root: string, ctx: EntityContext,
): Promise<PullResult> {
  let docs: Doc[];
  const defMapping: Record<string, unknown> = {};
  if (desc.hasServer && ctx.n8n && desc.pullFromServer) {
    const pulled = await desc.pullFromServer(ctx);
    docs = pulled.map((p) => ({ localId: p.localId, name: p.name, body: p.body, checksum: checksum(p.body) }));
    for (const p of pulled) {
      const v = p.defValue ?? p.serverId;
      if (v !== undefined) defMapping[p.localId] = v;
    }
  } else {
    docs = await store.getLive(desc.kind);
  }
  if (Object.keys(defMapping).length) {
    await store.withTransaction((session: Session) => store.putDefinitions(ctx.env, desc.kind, defMapping, session));
  }
  // Adopt the pulled state as the live baseline for this kind. Two reasons:
  //
  //  - credentials: a secret can never be read back, so this is the ONLY thing
  //    `plan` can diff a credential file against. Without it every credential looks
  //    changed after a pull and apply pushes `data` on all of them.
  //  - every kind: `apply` snapshots a generation from the LIVE docs and skips kinds
  //    with none. A kind that was pulled but never applied would be missing from the
  //    release — leaving its active pointer on an older generation (two `*` in
  //    `n8c list`) and making `restore <generation>` silently skip it.
  //
  // Workflow planning diffs against the n8n server, not live, so this never affects
  // the workflow plan.
  await store.withTransaction((session: Session) => store.putLive(desc.kind, docs, session));
  return { kind: desc.kind, count: docs.length, checksum: checksum(docs.map((d) => d.checksum).sort()), docs };
}

// Did this pull change `result.kind`, relative to its member in the active
// generation? A kind that is empty and has no member (a project with no credentials,
// say) is unchanged — commitPullGeneration never snapshots an empty kind, so it can
// never have a member, and comparing against `undefined` would report a change on
// every pull. A kind that became empty (member exists, no docs now) IS changed.
export function isKindChanged(member: { checksum: string } | undefined, result: PullResult): boolean {
  return member ? member.checksum !== result.checksum : result.docs.length > 0;
}

// Commit one pull as a single RELEASE: every non-empty kind is snapshotted under
// the SAME generation versionId and marked active — mirroring `apply`, so a pull
// produces one coherent generation instead of a per-kind version each.
export async function commitPullGeneration(
  store: Store, versionId: string, results: PullResult[], message?: string,
): Promise<void> {
  for (const r of results) {
    // An empty kind is never snapshotted: exportVersion throws "version not found" for
    // a version with no docs, so `restore` would fail on an empty member, and `apply`
    // skips empty kinds the same way. Consequence: when a kind BECOMES empty the new
    // generation lacks it and its active pointer stays on the older generation; the
    // next pull then sees no member and no docs, so isKindChanged is false and no
    // further generation is created.
    if (!r.docs.length) continue;
    await store.withTransaction(async (session: Session) => {
      await store.createSnapshot(r.kind, versionId, r.docs, r.checksum, session, message);
      await store.markActive(r.kind, versionId, session);
    });
  }
}

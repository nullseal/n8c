import type { Store, Doc } from '../store/store.ts';
import type { EntityDescriptor, EntityContext } from '../entities/types.ts';
import { checksum } from '../checksum.ts';
import { nextVersionId } from '../version.ts';

// pull captures the current server state (or, for serverless entities like
// prompts, the current live docs) as a NEW snapshot version for the archive.
// It never overwrites the live definition (apply owns live docs), but it DOES
// mark the pulled version active: a pull reflects the current reality, so `list`
// should star it as the current version for every kind. A pull whose bundle
// checksum matches ANY existing version is deduped (no new version) — that
// existing version is (re-)marked active instead.
export async function pullEntity(
  store: Store, desc: EntityDescriptor, _root: string, ctx: EntityContext, opts: { message?: string } = {},
): Promise<{ count: number; versionId?: string; checksum: string; deduped: boolean; docs: Doc[] }> {
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
    docs = await store.getLive(desc.kind); // prompts: snapshot current live
  }
  const bundleChecksum = checksum(docs.map((d) => d.checksum).sort());
  const versions = await store.listVersions(desc.kind);
  const dupVersion = versions.find((v) => v.checksum === bundleChecksum);
  const versionId = dupVersion ? undefined : nextVersionId();
  // Record the per-env localId→n8nId mapping (ids stay stable across envs/re-pulls),
  // snapshot the new version (unless deduped), and mark the pulled/matching version
  // active so it shows as the current version in `list`.
  await store.withTransaction(async (session) => {
    if (Object.keys(defMapping).length) await store.putDefinitions(ctx.env, desc.kind, defMapping, session);
    if (versionId) await store.createSnapshot(desc.kind, versionId, docs, bundleChecksum, session, opts.message);
    const activeVid = versionId ?? dupVersion?.versionId;
    if (activeVid) await store.markActive(desc.kind, activeVid, session);
  });
  return { count: docs.length, versionId, checksum: bundleChecksum, deduped: !!dupVersion, docs };
}

import type { Store } from '../store/store.ts';
import type { EntityDescriptor, EntityContext } from '../entities/types.ts';

export async function restoreEntity(store: Store, desc: EntityDescriptor, ctx: EntityContext, versionId: string): Promise<void> {
  const docs = await store.getVersion(desc.kind, versionId);
  if (!docs.length) throw new Error(`version ${versionId} not found for ${desc.kind}`);
  // status vs the CURRENT live (before overwrite) so the push can skip
  // redundant server writes (e.g. not re-creating an unchanged credential).
  const prevLive = new Map((await store.getLive(desc.kind)).map((d) => [d.localId, d.checksum]));
  const status: Record<string, string> = {};
  for (const d of docs) status[d.localId] = prevLive.get(d.localId) === d.checksum ? 'identical' : (prevLive.has(d.localId) ? 'changed' : 'new');
  await store.withTransaction(async (session) => {
    await store.putLive(desc.kind, docs, session);
    await store.markActive(desc.kind, versionId, session);
  });
  if (desc.hasServer && ctx.n8n && desc.pushToServer) {
    const serverDefs = await desc.pushToServer(ctx, docs as any, status);
    if (Object.keys(serverDefs).length) {
      await store.withTransaction((session) => store.putDefinitions(ctx.env, desc.kind, serverDefs, session));
    }
  }
}

import type { Store } from '../store/store.ts';
import type { EntityContext } from '../entities/types.ts';
import { credIndex, resolveCredLocalId } from './cred-map.ts';

// Build the credential mapping from the workflows' node credential refs (each
// carries {id, name}) — reliable even when the n8n Public API can't list
// credentials. localIds come from the shared resolver (single source of truth),
// and the result merges into the env's definitions (n8c_definitions).
export async function mapCredentialsFromWorkflows(store: Store, ctx: EntityContext): Promise<{ mapped: number }> {
  if (!ctx.n8n) return { mapped: 0 };
  const wfs: any[] = await ctx.n8n.listWorkflows();
  const mapping: Record<string, unknown> = { ...(await ctx.getDefinitions('credentials')) };
  const idx = credIndex(mapping);
  for (const w of wfs) {
    for (const node of w?.nodes ?? []) {
      for (const ref of Object.values<any>(node?.credentials ?? {})) {
        if (!ref?.id) continue;
        resolveCredLocalId(mapping, idx, String(ref.id), ref.name);
      }
    }
  }
  await store.withTransaction((session) => store.putDefinitions(ctx.env, 'credentials', mapping, session));
  return { mapped: Object.keys(mapping).length };
}

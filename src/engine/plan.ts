import type { Store } from '../store/store.ts';
import type { EntityDescriptor, EntityContext } from '../entities/types.ts';
import { buildDocs, diffNodes } from './apply.ts';
import { credIdMap } from './cred-map.ts';

export type PlanStatus = 'new' | 'changed' | 'identical' | 'removed';
// setActive: desired active state to enforce (activate/deactivate) when it differs
// from the server; undefined = leave active state as-is.
export type PlanRow = { localId: string; name: string; status: PlanStatus; checksum: string; nodes?: any[]; setActive?: boolean; archived?: boolean };

// Put both sides of the diff in ONE credential-id namespace. Files store
// env-neutral localIds (transfer.ts materializes them); n8n returns its own ids.
// Resolving the desired side through this env's mapping — the same lookup
// beforePush does at push time — lets a real rebinding surface as a change
// without every credentialed node reading as changed forever.
//
// Only the binding id is compared: `name` is display-only and a rename is
// already planned by the credentials kind, so diffing it would re-add the false
// positives this normalization exists to prevent.
//
// The resolved id is emitted under `credentialId`, not `id`: checksum()'s
// DEFAULT_VOLATILE list strips any key literally named `id` at EVERY nesting
// depth (src/checksum.ts), which would erase this value again before diffNodes
// ever hashes it. This projection is comparison-only (never pushed to n8n), so
// renaming the key here is free and lets diffNodes' normal checksum comparison
// catch binding drift on its own — no second pass needed.
export function normalizeCredentials(body: any, credMap: Record<string, string>): any {
  const b = JSON.parse(JSON.stringify(body ?? {}));
  for (const n of b.nodes ?? []) {
    if (!n.credentials) { delete n.credentials; continue; }
    const out: Record<string, { credentialId: string }> = {};
    for (const [type, ref] of Object.entries<any>(n.credentials)) {
      const id = ref?.id;
      if (id === undefined || id === null) continue;
      // An id with no mapping stays as-is and compares unequal — correct: either
      // it is already an n8n id, or its credential does not exist yet.
      out[type] = { credentialId: String(credMap[String(id)] ?? id) };
    }
    if (Object.keys(out).length) n.credentials = out; else delete n.credentials;
  }
  return b;
}

// Pure diff of one desired workflow body against the live server body. Also
// reconciles the `active` flag: a desired active state differing from the server
// makes the workflow non-noop and sets `setActive` for apply to enforce.
export function planDiff(
  desiredBody: any, serverBody: any | undefined, credMap: Record<string, string> = {},
): { status: PlanStatus; nodes: any[]; setActive?: boolean } {
  const wantActive = !!desiredBody?.active;
  if (!serverBody) {
    const nodes = (desiredBody?.nodes ?? []).map((n: any) => ({ id: n?.id ?? n?.name, name: n?.name ?? n?.id, checksum: '', status: 'new' as const }));
    return { status: 'new', nodes, setActive: wantActive ? true : undefined };
  }
  const normDesired = normalizeCredentials(desiredBody, credMap);
  const normServer = normalizeCredentials(serverBody, {});
  const nodes = diffNodes(normDesired, normServer);
  const activeChanged = wantActive !== !!serverBody?.active;
  const status: PlanStatus = nodes.some((n) => n.status !== 'identical') || activeChanged ? 'changed' : 'identical';
  return { status, nodes, setActive: activeChanged ? wantActive : undefined };
}

// Verify the desired files against the LIVE n8n server (uses the API key).
// Writes nothing and pushes nothing — the read-only "what would change?" view.
export async function planAgainstServer(store: Store, desc: EntityDescriptor, root: string, ctx: EntityContext): Promise<PlanRow[]> {
  if (!ctx.n8n) throw new Error('--plan needs an n8n connection (set N8N_BASE + N8N_API_KEY)');
  if (!desc.pullFromServer) throw new Error(`--plan is not supported for ${desc.kind} (no server state to compare)`);
  const desired = await buildDocs(desc, root, ctx);
  const server = await desc.pullFromServer(ctx);
  const credMap = credIdMap(await ctx.getDefinitions('credentials'));
  const serverByLocal = new Map(server.map((s: any) => [s.localId, s.body]));
  const archivedByLocal = new Map(server.map((s: any) => [s.localId, !!s.archived]));
  const seen = new Set<string>();
  const rows: PlanRow[] = [];
  for (const d of desired) {
    seen.add(d.localId);
    const { status, nodes, setActive } = planDiff(d.body, serverByLocal.get(d.localId), credMap);
    rows.push({ localId: d.localId, name: d.name, status, checksum: d.checksum, nodes: status === 'identical' ? undefined : nodes, setActive, archived: archivedByLocal.get(d.localId) ?? false });
  }
  // Deployed on the server but absent from the files → drift the other way.
  for (const s of server as any[]) if (!seen.has(s.localId)) rows.push({ localId: s.localId, name: s.name, status: 'removed', checksum: '', archived: !!s.archived });
  return rows;
}

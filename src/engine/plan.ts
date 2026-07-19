import type { Store } from '../store/store.ts';
import type { EntityDescriptor, EntityContext } from '../entities/types.ts';
import { buildDocs, diffNodes } from './apply.ts';

export type PlanStatus = 'new' | 'changed' | 'identical' | 'removed';
// setActive: desired active state to enforce (activate/deactivate) when it differs
// from the server; undefined = leave active state as-is.
export type PlanRow = { localId: string; name: string; status: PlanStatus; checksum: string; nodes?: any[]; setActive?: boolean };

// Strip env-specific noise so a code↔server diff reflects real logic drift:
// credentials are env-specific ids (compared via `environment`, not here), so
// drop them. Node-level volatile fields are already ignored by diffNodes.
function comparable(body: any): any {
  const b = JSON.parse(JSON.stringify(body ?? {}));
  for (const n of b.nodes ?? []) delete n.credentials;
  return b;
}

// Pure diff of one desired workflow body against the live server body. Also
// reconciles the `active` flag: a desired active state differing from the server
// makes the workflow non-noop and sets `setActive` for apply to enforce.
export function planDiff(desiredBody: any, serverBody: any | undefined): { status: PlanStatus; nodes: any[]; setActive?: boolean } {
  const wantActive = !!desiredBody?.active;
  if (!serverBody) {
    const nodes = (desiredBody?.nodes ?? []).map((n: any) => ({ id: n?.id ?? n?.name, name: n?.name ?? n?.id, checksum: '', status: 'new' as const }));
    return { status: 'new', nodes, setActive: wantActive ? true : undefined };
  }
  const nodes = diffNodes(comparable(desiredBody), comparable(serverBody));
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
  const serverByLocal = new Map(server.map((s: any) => [s.localId, s.body]));
  const seen = new Set<string>();
  const rows: PlanRow[] = [];
  for (const d of desired) {
    seen.add(d.localId);
    const { status, nodes, setActive } = planDiff(d.body, serverByLocal.get(d.localId));
    rows.push({ localId: d.localId, name: d.name, status, checksum: d.checksum, nodes: status === 'identical' ? undefined : nodes, setActive });
  }
  // Deployed on the server but absent from the files → drift the other way.
  for (const s of server as any[]) if (!seen.has(s.localId)) rows.push({ localId: s.localId, name: s.name, status: 'removed', checksum: '' });
  return rows;
}

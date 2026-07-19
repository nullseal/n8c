import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from '../store/store.ts';
import type { EntityContext } from '../entities/types.ts';
import { listEntityIds, readEntity, entityDir } from '../layout.ts';

// Collect every `.node` reference inside a connections subtree.
function collectTargets(conn: unknown, out: string[]): void {
  if (Array.isArray(conn)) { for (const c of conn) collectTargets(c, out); return; }
  if (conn && typeof conn === 'object') {
    const o = conn as Record<string, unknown>;
    if (typeof o.node === 'string') out.push(o.node);
    for (const v of Object.values(o)) collectTargets(v, out);
  }
}

// validateAll returns a list of human-readable problems (empty = OK).
export async function validateAll(root: string, ctx: EntityContext, _store: Store): Promise<string[]> {
  const problems: string[] = [];
  const credDefs = await ctx.getDefinitions('credentials');
  // A node credential ref is OK if it is EITHER already deployed (in credDefs)
  // OR a local credential entity exists — the global apply deploys credentials
  // first, so a local entity will have a mapping by the time workflows push.
  const localCreds = new Set(listEntityIds(root, 'credentials'));
  const promptKeys = new Set<string>();

  // (2a) top-level prompts contribute keys
  for (const id of listEntityIds(root, 'prompts')) {
    const { body, metadata } = await readEntity(root, 'prompts', id);
    const key = (body as any)?.key ?? metadata.key ?? id;
    if (promptKeys.has(key)) problems.push(`duplicate prompt key ${key}`);
    else promptKeys.add(key);
  }

  for (const wid of listEntityIds(root, 'workflows')) {
    const { body, prompts, metadata } = await readEntity(root, 'workflows', wid);
    const nodes: any[] = (body as any).nodes ?? [];
    const wfName = metadata.name ?? wid;

    // (1) credential mappings present — grouped by credential id, listing the
    // node names that use it (readable, deduplicated).
    const missingCreds = new Map<string, string[]>();
    for (const node of nodes) {
      if (!node.credentials) continue;
      for (const type of Object.keys(node.credentials)) {
        const cid = node.credentials[type]?.id;
        if (cid && !(cid in credDefs) && !localCreds.has(cid)) {
          if (!missingCreds.has(cid)) missingCreds.set(cid, []);
          missingCreds.get(cid)!.push(node.name ?? node.id);
        }
      }
    }
    for (const [cid, usedBy] of missingCreds) {
      const nodes5 = usedBy.slice(0, 5).join(', ') + (usedBy.length > 5 ? `, +${usedBy.length - 5} more` : '');
      problems.push(`workflow "${wfName}": missing credential ${cid} (used by: ${nodes5})`);
    }

    // (2b) node prompt keys unique across everything
    for (const p of prompts) {
      if (promptKeys.has(p.localId)) problems.push(`duplicate prompt key ${p.localId}`);
      else promptKeys.add(p.localId);
    }

    // (3) connection nodeIds exist (metadata.connections is keyed by nodeId)
    const nodeIds = new Set<string>(nodes.map((n) => n.id));
    for (const [srcId, conn] of Object.entries(metadata.connections ?? {})) {
      if (!nodeIds.has(srcId)) problems.push(`workflow ${wid}: connection source ${srcId} is not a known node`);
      const targets: string[] = [];
      collectTargets(conn, targets);
      for (const t of targets) if (!nodeIds.has(t)) problems.push(`workflow ${wid}: connection target ${t} is not a known node`);
    }
  }

  // (4) encryption key required when any credential carries data and encryption is on
  if (ctx.encrypted && !ctx.encryptionKey) {
    for (const cid of listEntityIds(root, 'credentials')) {
      if (!existsSync(join(entityDir(root, 'credentials', cid), 'apply.ts'))) continue;
      const { body } = await readEntity(root, 'credentials', cid);
      if ((body as any)?.data !== undefined) {
        problems.push('N8C_CREDENTIAL_ENCRYPTION_KEY required to encrypt credential data');
        break;
      }
    }
  }

  return problems;
}

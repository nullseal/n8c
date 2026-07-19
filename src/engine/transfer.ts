import type { Store } from '../store/store.ts';
import type { EntityDescriptor, EntityContext } from '../entities/types.ts';
import { checksum } from '../checksum.ts';
import { nextVersionId } from '../version.ts';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { writeEntity, entityDir, listEntityIds } from '../layout.ts';
import { materializeWorkflowSource } from './materialize.ts';
import { decryptCredentialData } from '../entities/credential.ts';
import { buildDocs } from './apply.ts';
import { credIndex } from './cred-map.ts';
import { scanWorkflowSecrets } from './secret-scan.ts';

// Render a credential apply.ts: name/type + a commented hint for the secret.
// The real `data` value (resolved from process.env at read time) is NEVER written
// back to a file — that would leak the secret into a committed source file.
function credentialSource(body: any): string {
  const hint = `  // secret from .env — the value resolves at read time, never committed:\n  // data: { token: process.env.MY_TOKEN },`;
  return `export default {\n  "name": ${JSON.stringify(body.name)},\n  "type": ${JSON.stringify(body.type)},\n${hint}\n};\n`;
}

// Export a stored VERSION to files (used by restore / list-then-export). Looks up
// the version's docs, then renders them. Throws if the version has no docs.
export async function exportVersion(store: Store, desc: EntityDescriptor, root: string, versionId: string, ctx?: EntityContext): Promise<string[]> {
  const docs = await store.getVersion(desc.kind, versionId);
  if (!docs.length) throw new Error(`version ${versionId} not found for ${desc.kind}`);
  return exportDocs(desc, root, docs, ctx);
}

// Render a set of entity docs to files. Each entity's own folder is WIPED first
// so a re-export is clean. A workflow becomes a single readable `apply.ts` +
// `metadata.json`; credentials/prompts export as a leaf apply.ts. Empty input is
// a no-op (nothing to write) — callers that require a version use exportVersion.
export async function exportDocs(desc: EntityDescriptor, root: string, docs: import('../store/store.ts').Doc[], ctx?: EntityContext): Promise<string[]> {
  const warnings: string[] = []; // hardcoded-secret findings (n8c/ is committed)
  // Mirror the exported set: remove any entity dir whose localId isn't in `docs`.
  // Every caller passes the FULL set for the kind (a pull, or a full version), so
  // a dir that's no longer present is an orphan. Without this, dirs left by an
  // earlier pull (e.g. a prompt whose localId changed) linger and read as phantom
  // "create" in `plan` forever.
  const keep = new Set(docs.map((d) => d.localId));
  for (const id of listEntityIds(root, desc.kind)) {
    if (!keep.has(id)) rmSync(entityDir(root, desc.kind, id), { recursive: true, force: true });
  }
  // For workflows, build n8nCredId → credentialLocalId so exported files
  // reference credentials by env-neutral localId, not the sticky n8n id.
  // n8nCredId → credentialLocalId (UUID-preferring), so exported files reference
  // credentials by env-neutral localId — never the sticky n8n id.
  let n8nIdToLocal: Record<string, string> = {};
  let knownLocalIds = new Set<string>();
  if (desc.kind === 'workflows' && ctx) {
    const credDefs = await ctx.getDefinitions('credentials');
    for (const [n8nId, localId] of credIndex(credDefs)) n8nIdToLocal[n8nId] = localId;
    knownLocalIds = new Set(Object.keys(credDefs)); // refs already relinked to a localId
  }
  for (const d of docs) {
    const dir = entityDir(root, desc.kind, d.localId);
    if (desc.kind === 'workflows') {
      // Validate credential refs FIRST — no silent fallback to raw n8n id.
      const used: Record<string, unknown> = {};
      for (const node of (d.body as any)?.nodes ?? []) {
        for (const ref of Object.values<any>(node?.credentials ?? {})) {
          if (!ref?.id) continue;
          // relink an n8n id → localId, OR keep a ref that's ALREADY a localId
          // (idempotent — a re-export of an applied workflow shouldn't throw).
          const localId = n8nIdToLocal[String(ref.id)] ?? (knownLocalIds.has(String(ref.id)) ? String(ref.id) : undefined);
          if (!localId) throw new Error(`workflow ${d.localId}: credential ${ref.id} (${ref.name ?? ''}) has no localId mapping — run \`n8c pull\` first (it maps credentials from workflow nodes)`);
          used[localId] = { name: ref.name };
        }
      }
      for (const f of scanWorkflowSecrets(d.body)) warnings.push(`${d.name} (${d.localId}) → ${f}`);
      rmSync(dir, { recursive: true, force: true }); // clean before writing
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'metadata.json'), JSON.stringify({ name: d.name }, null, 2) + '\n');
      writeFileSync(join(dir, 'apply.ts'), materializeWorkflowSource(d.body, n8nIdToLocal));
      // environment.json: the credentials this workflow uses, by env-neutral
      // localId + name — a committed record of the credentials this workflow uses.
      if (Object.keys(used).length) writeFileSync(join(dir, 'environment.json'), JSON.stringify({ credentials: used }, null, 2) + '\n');
    } else if (desc.kind === 'credentials') {
      rmSync(dir, { recursive: true, force: true }); // clean before writing
      // decrypt (keeps env: markers) so the file shows markers, not a blob.
      const body = ctx ? decryptCredentialData(ctx, d.body as any) : (d.body as any);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'metadata.json'), JSON.stringify({ name: d.name }, null, 2) + '\n');
      writeFileSync(join(dir, 'apply.ts'), credentialSource(body));
    } else {
      rmSync(dir, { recursive: true, force: true }); // clean before writing
      writeEntity(root, desc.kind, d.localId, { name: d.name }, d.body);
    }
  }
  return warnings;
}

export async function importDir(store: Store, desc: EntityDescriptor, root: string, ctx: EntityContext): Promise<{ versionId: string }> {
  const docs = await buildDocs(desc, root, ctx);
  const bundleChecksum = checksum(docs.map((d) => d.checksum).sort());
  const versionId = nextVersionId();
  await store.withTransaction((session) => store.createSnapshot(desc.kind, versionId, docs, bundleChecksum, session));
  return { versionId };
}

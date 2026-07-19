import { randomUUID } from 'node:crypto';
import type { Store, Doc } from '../store/store.ts';
import type { EntityContext } from '../entities/types.ts';
import { checksum } from '../checksum.ts';
import { nextVersionId } from '../version.ts';
import { extractWorkflowPrompts } from './extract-prompts.ts';

// A prompt's provenance key (workflow + node + type + index) — stable identity
// used to reuse the same localId across re-pulls.
function provKey(s: { workflow: string; nodeName: string; nodeType: string; index: number }, type: string): string {
  return `${s.workflow}::${s.nodeName}::${type}::${s.index}`;
}

// prompt pull --from-nodes: scan every n8n workflow's LLM nodes, extract the
// system/user prompts, and snapshot them as a prompt version. localId is a UUID
// (stable across re-pulls via provenance reverse-lookup); provenance + type are
// stored in the doc body.
//
// prompts are DB-only (hasServer:false) and, unlike workflows/credentials, `plan`
// diffs the files against the DB LIVE docs — not against n8n. The extracted set IS
// the current reality, so pull ALSO adopts it as the live baseline. Without this,
// live stays empty and `pull` then `plan` reports every extracted prompt as "new"
// (the exact confusion: 32 files "to create" right after a pull). Also marks the
// pulled version active. Writes ONLY n8c_prompts — never the runtime prompt-content
// registry (n8c_prompt_contents), which the load_prompts node reads.
export async function pullPromptsFromNodes(
  store: Store, ctx: EntityContext, opts: { message?: string } = {},
): Promise<{ count: number; versionId?: string; checksum: string; deduped: boolean; docs: Doc[] }> {
  if (!ctx.n8n) throw new Error('prompt pull --from-nodes needs an n8n connection (set N8N_BASE)');
  const wfs = await ctx.n8n.listWorkflows();

  // provenance -> existing localId, gathered from every prior prompt snapshot.
  const provToLocal = new Map<string, string>();
  for (const v of await store.listVersions('prompts')) {
    for (const d of await store.getVersion('prompts', v.versionId)) {
      const b: any = d.body;
      if (b?.source) provToLocal.set(provKey(b.source, b.type), d.localId);
    }
  }

  const docs: Doc[] = [];
  for (const w of wfs as any[]) {
    if (w.isArchived) continue; // never scan archived workflows
    const workflow = (w.meta && w.meta.n8cLocalId) ?? String(w.id);
    for (const e of extractWorkflowPrompts(w)) {
      const source = { workflow, nodeName: e.nodeName, nodeType: e.nodeType, index: e.index };
      const localId = provToLocal.get(provKey(source, e.type)) ?? randomUUID();
      const body = { content: e.content, type: e.type, source };
      docs.push({ localId, name: `${e.nodeName} [${e.type}]`, body, checksum: checksum(body) });
    }
  }

  const bundleChecksum = checksum(docs.map((d) => d.checksum).sort());
  const versions = await store.listVersions('prompts');
  const dupVersion = versions.find((v) => v.checksum === bundleChecksum);
  if (dupVersion) {
    await store.withTransaction(async (session) => {
      await store.putLive('prompts', docs, session);           // adopt reality as live → plan stays clean
      await store.markActive('prompts', dupVersion.versionId, session);
    });
    return { count: docs.length, checksum: bundleChecksum, deduped: true, docs };
  }
  const versionId = nextVersionId();
  await store.withTransaction(async (session) => {
    await store.putLive('prompts', docs, session);             // adopt reality as live → plan stays clean
    await store.createSnapshot('prompts', versionId, docs, bundleChecksum, session, opts.message);
    await store.markActive('prompts', versionId, session);
  });
  return { count: docs.length, versionId, checksum: bundleChecksum, deduped: false, docs };
}

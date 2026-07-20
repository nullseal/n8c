import { randomUUID } from 'node:crypto';
import type { Store, Doc } from '../store/store.ts';
import type { EntityContext } from '../entities/types.ts';
import { checksum } from '../checksum.ts';
import type { PullResult } from './pull.ts';
import { extractWorkflowPrompts } from './extract-prompts.ts';

// A prompt's provenance key (workflow + node + type + index) — stable identity
// used to reuse the same localId across re-pulls.
function provKey(s: { workflow: string; nodeName: string; nodeType: string; index: number }, type: string): string {
  return `${s.workflow}::${s.nodeName}::${type}::${s.index}`;
}

// prompt pull --from-nodes: scan every n8n workflow's LLM nodes and extract the
// system/user prompts. localId is a UUID (stable across re-pulls via provenance
// reverse-lookup); provenance + type are stored in the doc body.
//
// prompts are DB-only (hasServer:false) and, unlike workflows/credentials, `plan`
// diffs the files against the DB LIVE docs — not against n8n. The extracted set IS
// the current reality, so pull adopts it as the live baseline. Without this, live
// stays empty and `pull` then `plan` reports every extracted prompt as "new" (the
// exact confusion: 32 files "to create" right after a pull). Writes ONLY
// n8c_prompts — never the runtime prompt-content registry (n8c_prompt_contents),
// which the load_prompts node reads. Like pullEntity it writes NO version: the
// generation is committed once, for all kinds, by commitPullGeneration.
export async function pullPromptsFromNodes(
  store: Store, ctx: EntityContext,
): Promise<PullResult> {
  if (!ctx.n8n) throw new Error('prompt pull --from-nodes needs an n8n connection (set N8N_BASE)');
  const wfs = await ctx.n8n.listWorkflows();

  // provenance -> existing localId, so a re-pull reuses ids instead of minting new
  // ones (new ids would orphan the on-disk dirs). Seeded from every prior snapshot
  // AND from the current live docs — live wins, and it keeps ids stable even before
  // a generation has been committed (pull writes live first, versions only later).
  const provToLocal = new Map<string, string>();
  const seed = (docs: Doc[]) => {
    for (const d of docs) {
      const b: any = d.body;
      if (b?.source) provToLocal.set(provKey(b.source, b.type), d.localId);
    }
  };
  for (const v of await store.listVersions('prompts')) seed(await store.getVersion('prompts', v.versionId));
  seed(await store.getLive('prompts'));

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

  // adopt reality as the live baseline → `plan` right after a pull stays clean
  await store.withTransaction((session) => store.putLive('prompts', docs, session));
  return { kind: 'prompts', count: docs.length, checksum: checksum(docs.map((d) => d.checksum).sort()), docs };
}

import type { EntityDescriptor } from './types.ts';

// Runtime prompt content — the docs the n8n `load_prompts` node reads from
// `n8c_prompt_contents`. DB-only: never pushed to n8n (hasServer:false). Its live
// docs are stored flat ({key, content|blocks} at top level, see live-doc.ts) so
// the node reads x.json.key / x.json.content. Distinct from `prompts` (which are
// the build-time prompts wired into agent nodes).
export const promptContent: EntityDescriptor = {
  kind: 'promptContents',
  hasServer: false,
};

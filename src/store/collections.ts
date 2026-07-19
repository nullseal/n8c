// n8c-managed Mongo collections. Every name is configurable — a global
// `collectionPrefix` (default `n8c_`) and/or per-collection overrides in
// `n8c.config.json` `collections`:
//   { "collectionPrefix": "myapp_", "collections": { "promptContents": "runtime_prompts" } }
//
//  - <prefix>workflows / prompts / credentials — LIVE entity docs (1 per entity).
//  - <prefix>manifests       — version metadata (index of versions) for all kinds.
//  - <prefix>definitions      — per-env localId→n8nId mappings.
//  - <prefix>prompt_contents  — runtime-facing live prompt content {key, content|blocks}
//                               (what the n8n `load_prompts` node reads).
export const COLLECTION_KEYS = ['workflows', 'prompts', 'credentials', 'definitions', 'manifests', 'promptContents'] as const;
export type CollectionKey = (typeof COLLECTION_KEYS)[number];
export type Collections = Record<CollectionKey, string>;

const KINDS = new Set(['workflows', 'prompts', 'credentials', 'promptContents']);
const SUFFIX: Collections = {
  workflows: 'workflows', prompts: 'prompts', credentials: 'credentials',
  definitions: 'definitions', manifests: 'manifests', promptContents: 'prompt_contents',
};

// Resolve ALL collection names from config: prefix + suffix, unless a per-name
// override is given. `collections` keys are the logical CollectionKey names.
export function resolveCollections(cfg?: { collectionPrefix?: string; collections?: Record<string, string> }): Collections {
  const prefix = cfg?.collectionPrefix ?? 'n8c_';
  const ov = cfg?.collections ?? {};
  const out = {} as Collections;
  for (const k of COLLECTION_KEYS) out[k] = ov[k] ?? prefix + SUFFIX[k];
  return out;
}

// Physical live-collection name for an entity kind.
export function collectionForKind(cols: Collections, kind: string): string {
  if (!KINDS.has(kind)) throw new Error(`unknown kind ${kind}`);
  return cols[kind as CollectionKey];
}

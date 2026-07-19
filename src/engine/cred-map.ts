import { randomUUID } from 'node:crypto';

// Single source of truth for "the env-neutral localId of a given n8n credential".
// Historically several call sites (credential pull, mapCredentialsFromWorkflows,
// environment init/export) each reverse-looked-up + minted UUIDs independently,
// and export fell back to writing the raw n8n id as a localId. That produced a
// polluted mapping: some keys were UUIDs, some were n8n ids, and one physical
// credential could have several localIds. These helpers centralise the rule.

// A localId is a UUID (env-neutral). Structural check — no regex (repo pref).
export function isLocalId(s: unknown): boolean {
  return typeof s === 'string' && s.length === 36 && s[8] === '-' && s[13] === '-' && s[18] === '-' && s[23] === '-';
}

type CredMapping = Record<string, any>;

// Reverse index n8nId → localId over a credentials mapping. When several keys
// point at the same n8n id (pollution), a UUID-shaped localId always wins, so a
// raw-n8n-id key never shadows the canonical localId.
export function credIndex(mapping: CredMapping): Map<string, string> {
  const idx = new Map<string, string>();
  for (const [localId, v] of Object.entries(mapping ?? {})) {
    const n8nId = String(v?.id ?? v);
    const cur = idx.get(n8nId);
    if (cur === undefined || (!isLocalId(cur) && isLocalId(localId))) idx.set(n8nId, localId);
  }
  return idx;
}

// Resolve the stable localId for an n8n credential id: reuse the known one, else
// mint a UUID exactly once. Mutates both `mapping` and `idx` so repeated calls in
// a batch stay consistent.
export function resolveCredLocalId(mapping: CredMapping, idx: Map<string, string>, n8nId: string, name?: string): string {
  const existing = idx.get(n8nId);
  if (existing) {
    mapping[existing] = { id: n8nId, name: name ?? (mapping[existing] as any)?.name };
    return existing;
  }
  const localId = randomUUID();
  mapping[localId] = { id: n8nId, name };
  idx.set(n8nId, localId);
  return localId;
}

// Collapse a localId→value mapping so every n8n id appears exactly once (UUID
// localId preferred). Values (string n8nId for workflows, {id,name} for
// credentials) are preserved verbatim. Used on every putDefinitions so a store
// can hold a unique-per-n8nId mapping — and legacy pollution self-heals on write.
export function normalizeMapping(mapping: CredMapping): CredMapping {
  const idx = credIndex(mapping);
  const out: CredMapping = {};
  const seen = new Set<string>();
  for (const [localId, value] of Object.entries(mapping ?? {})) {
    const n8nId = String((value as any)?.id ?? value);
    if (idx.get(n8nId) !== localId || seen.has(n8nId)) continue;
    seen.add(n8nId);
    out[localId] = value;
  }
  return out;
}

// Break a localId→value mapping into per-entry rows for a document store, with
// the n8n id lifted out for a unique index.
export function mappingRows(mapping: CredMapping): { localId: string; n8nId: string; value: unknown }[] {
  return Object.entries(normalizeMapping(mapping)).map(([localId, value]) => ({ localId, n8nId: String((value as any)?.id ?? value), value }));
}


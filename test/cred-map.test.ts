import { test } from 'node:test';
import assert from 'node:assert/strict';
import { credIndex, resolveCredLocalId, isLocalId, normalizeMapping, mappingRows } from '../src/engine/cred-map.ts';
import { MemoryStore } from '../src/store/memory.ts';

test('isLocalId accepts UUIDs, rejects raw n8n ids', () => {
  assert.equal(isLocalId('c05bdb73-49cb-47a4-a7b3-8ecacd6f4137'), true);
  assert.equal(isLocalId('xaY3BcbugejKug7T'), false);
  assert.equal(isLocalId('gpNzYPjMBrcX6utK'), false);
  assert.equal(isLocalId(''), false);
  assert.equal(isLocalId(undefined as any), false);
});

test('credIndex prefers a UUID localId over a raw-n8n-id key for the same n8n id', () => {
  const mapping = {
    'gpNzYPjMBrcX6utK': { id: 'gpNzYPjMBrcX6utK', name: 'OpenAI' }, // polluted key
    '209b9379-2e64-4f45-a0d8-1deb99271e9e': { id: 'gpNzYPjMBrcX6utK', name: 'OpenAI' }, // canonical
  };
  const idx = credIndex(mapping);
  assert.equal(idx.get('gpNzYPjMBrcX6utK'), '209b9379-2e64-4f45-a0d8-1deb99271e9e');
});

test('resolveCredLocalId reuses the known localId, never re-mints', () => {
  const mapping: Record<string, any> = { 'c05bdb73-49cb-47a4-a7b3-8ecacd6f4137': { id: 'UVlZPrugEfe4CZTZ', name: 'Mongo' } };
  const idx = credIndex(mapping);
  const a = resolveCredLocalId(mapping, idx, 'UVlZPrugEfe4CZTZ', 'Mongo');
  const b = resolveCredLocalId(mapping, idx, 'UVlZPrugEfe4CZTZ', 'Mongo');
  assert.equal(a, 'c05bdb73-49cb-47a4-a7b3-8ecacd6f4137');
  assert.equal(b, a);
  assert.equal(Object.keys(mapping).length, 1);
});

test('resolveCredLocalId mints a single UUID for a new n8n id', () => {
  const mapping: Record<string, any> = {};
  const idx = credIndex(mapping);
  const id = resolveCredLocalId(mapping, idx, 'NEW_N8N_ID', 'Fresh');
  assert.equal(isLocalId(id), true);
  assert.deepEqual(mapping[id], { id: 'NEW_N8N_ID', name: 'Fresh' });
  // same id resolves to the just-minted localId
  assert.equal(resolveCredLocalId(mapping, idx, 'NEW_N8N_ID', 'Fresh'), id);
});

test('normalizeMapping collapses the exact polluted mapping to one localId per n8n id', () => {
  const polluted = {
    'xaY3BcbugejKug7T': { id: 'xaY3BcbugejKug7T', name: 'Shopify Admin' },
    'c05bdb73-49cb-47a4-a7b3-8ecacd6f4137': { id: 'UVlZPrugEfe4CZTZ', name: 'MongoDB IZIHelp Staging' },
    '209b9379-2e64-4f45-a0d8-1deb99271e9e': { id: 'gpNzYPjMBrcX6utK', name: 'OpenAI IZIHelp Staging' },
    'gpNzYPjMBrcX6utK': { id: 'gpNzYPjMBrcX6utK', name: 'OpenAI IZIHelp Staging' },
    'fd3d4faf-ed19-4f06-bea7-706d976c0f9f': { id: 'UVlZPrugEfe4CZTZ', name: 'MongoDB IZIHelp Staging' },
  };
  const n = normalizeMapping(polluted);
  const ids = Object.values(n).map((v: any) => v.id).sort();
  assert.deepEqual(ids, ['UVlZPrugEfe4CZTZ', 'gpNzYPjMBrcX6utK', 'xaY3BcbugejKug7T']); // 3 unique n8n ids
  // OpenAI + Mongo resolve to the UUID keys, not the raw-id / duplicate keys
  assert.ok(n['209b9379-2e64-4f45-a0d8-1deb99271e9e']);
  assert.ok(!n['gpNzYPjMBrcX6utK']);
  assert.equal(Object.keys(n).filter((k) => (n as any)[k].id === 'UVlZPrugEfe4CZTZ').length, 1);
});

test('mappingRows lifts n8nId out and normalizes (ready for the unique index)', () => {
  const rows = mappingRows({ 'aaaa1111-1111-4111-8111-111111111111': { id: 'N1', name: 'X' }, 'N1': { id: 'N1', name: 'X' } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].n8nId, 'N1');
  assert.equal(rows[0].localId, 'aaaa1111-1111-4111-8111-111111111111');
});

test('putDefinitions stores a unique mapping (MemoryStore parity with Mongo index)', async () => {
  const store = new MemoryStore();
  await store.withTransaction((s) => store.putDefinitions('staging', 'credentials', {
    'c05bdb73-49cb-47a4-a7b3-8ecacd6f4137': { id: 'UVlZ', name: 'Mongo' },
    'fd3d4faf-ed19-4f06-bea7-706d976c0f9f': { id: 'UVlZ', name: 'Mongo' }, // dup n8n id
  }, s));
  const defs = await store.getDefinitions('staging', 'credentials');
  assert.equal(Object.keys(defs).length, 1);
  assert.ok(defs['c05bdb73-49cb-47a4-a7b3-8ecacd6f4137']);
});

test('putDefinitions keeps workflow mapping shape (localId → n8nId string)', async () => {
  const store = new MemoryStore();
  await store.withTransaction((s) => store.putDefinitions('staging', 'workflows', { 'w-uuid': 'N8N_WF_1' }, s));
  assert.deepEqual(await store.getDefinitions('staging', 'workflows'), { 'w-uuid': 'N8N_WF_1' });
});

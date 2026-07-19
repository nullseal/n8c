import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/store/memory.ts';

test('live docs round-trip', async () => {
  const s = new MemoryStore();
  const docs = [{ localId: 'a', name: 'A', body: { x: 1 }, checksum: 'c1' }];
  await s.withTransaction((session) => s.putLive('workflows', docs, session));
  assert.deepEqual(await s.getLive('workflows'), docs);
});

test('snapshot + manifest + markActive', async () => {
  const s = new MemoryStore();
  const docs = [{ localId: 'a', name: 'A', body: {}, checksum: 'c1' }];
  await s.withTransaction((session) => s.createSnapshot('workflows', '2026-01-01T00:00:00Z', docs, 'bundle1', session));
  await s.withTransaction((session) => s.createSnapshot('workflows', '2026-01-02T00:00:00Z', docs, 'bundle2', session));
  await s.withTransaction((session) => s.markActive('workflows', '2026-01-02T00:00:00Z', session));
  const versions = await s.listVersions('workflows');
  assert.equal(versions.length, 2);
  assert.equal(versions.find((v) => v.isActive)?.versionId, '2026-01-02T00:00:00Z');
  assert.deepEqual(await s.getVersion('workflows', '2026-01-01T00:00:00Z'), docs);
});

test('dropVersion removes a version (manifest + docs), leaving others intact', async () => {
  const s = new MemoryStore();
  const docs = [{ localId: 'a', name: 'A', body: {}, checksum: 'c1' }];
  await s.withTransaction((x) => s.createSnapshot('prompts', 'V1', docs, 'b1', x));
  await s.withTransaction((x) => s.createSnapshot('prompts', 'V2', docs, 'b2', x));
  await s.withTransaction((x) => s.dropVersion('prompts', 'V1', x));
  const versions = await s.listVersions('prompts');
  assert.deepEqual(versions.map((v) => v.versionId), ['V2'], 'V1 gone from manifest');
  assert.deepEqual(await s.getVersion('prompts', 'V1'), [], 'V1 docs gone');
  assert.deepEqual(await s.getVersion('prompts', 'V2'), docs, 'V2 intact');
  // idempotent
  await s.withTransaction((x) => s.dropVersion('prompts', 'V1', x));
  assert.equal((await s.listVersions('prompts')).length, 1);
});

test('definitions round-trip per env', async () => {
  const s = new MemoryStore();
  await s.withTransaction((session) => s.putDefinitions('staging', 'workflows', { a: 'n8n-1' }, session));
  assert.deepEqual(await s.getDefinitions('staging', 'workflows'), { a: 'n8n-1' });
  assert.deepEqual(await s.getDefinitions('prod', 'workflows'), {});
});

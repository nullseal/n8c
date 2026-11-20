import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStore } from '../src/store/sqlite.ts';

async function freshStore(): Promise<SqliteStore> {
  const s = new SqliteStore(':memory:');
  await s.init();
  return s;
}

test('capabilities: prompt-content and backup disabled', async () => {
  const s = await freshStore();
  try {
    assert.equal(s.capabilities.promptContents, false);
    assert.equal(s.capabilities.backup, false);
    assert.throws(() => s.backupDb(), /only supported for the mongodb store/);
  } finally { await s.close(); }
});

test('live docs round-trip (JSON body preserved)', async () => {
  const s = await freshStore();
  try {
    const docs = [{ localId: 'a', name: 'A', body: { x: 1, nested: { y: [2, 3] } }, checksum: 'c1' }];
    await s.withTransaction((session) => s.putLive('workflows', docs, session));
    assert.deepEqual(await s.getLive('workflows'), docs);
    // replace-semantics: putLive wipes the prior live set for the kind
    await s.withTransaction((session) => s.putLive('workflows', [], session));
    assert.deepEqual(await s.getLive('workflows'), []);
  } finally { await s.close(); }
});

test('upsertLive inserts then updates in place', async () => {
  const s = await freshStore();
  try {
    await s.withTransaction((session) => s.upsertLive('prompts', [{ localId: 'p1', name: 'P', body: { v: 1 }, checksum: 'c1' }], session));
    await s.withTransaction((session) => s.upsertLive('prompts', [{ localId: 'p1', name: 'P', body: { v: 2 }, checksum: 'c2' }], session));
    const live = await s.getLive('prompts');
    assert.equal(live.length, 1);
    assert.deepEqual(live[0], { localId: 'p1', name: 'P', body: { v: 2 }, checksum: 'c2' });
  } finally { await s.close(); }
});

test('snapshot + manifest + markActive + getVersion', async () => {
  const s = await freshStore();
  try {
    const docs = [{ localId: 'a', name: 'A', body: { k: 1 }, checksum: 'c1' }];
    await s.withTransaction((session) => s.createSnapshot('workflows', '2026-01-01T00:00:00Z', docs, 'bundle1', session, 'first'));
    await s.withTransaction((session) => s.createSnapshot('workflows', '2026-01-02T00:00:00Z', docs, 'bundle2', session));
    await s.withTransaction((session) => s.markActive('workflows', '2026-01-02T00:00:00Z', session));
    const versions = await s.listVersions('workflows');
    assert.equal(versions.length, 2);
    assert.equal(versions.find((v) => v.isActive)?.versionId, '2026-01-02T00:00:00Z');
    assert.equal(versions[0].message, 'first');
    assert.deepEqual(await s.getVersion('workflows', '2026-01-01T00:00:00Z'), docs);
  } finally { await s.close(); }
});

test('definitions round-trip per env, unique per n8n id', async () => {
  const s = await freshStore();
  try {
    await s.withTransaction((session) => s.putDefinitions('staging', 'workflows', { a: 'n8n-1' }, session));
    assert.deepEqual(await s.getDefinitions('staging', 'workflows'), { a: 'n8n-1' });
    assert.deepEqual(await s.getDefinitions('prod', 'workflows'), {});
    // credential-shaped values ({id,name}) survive round-trip
    await s.withTransaction((session) => s.putDefinitions('staging', 'credentials', { 'uuid-1': { id: 'N1', name: 'OpenAI' } }, session));
    assert.deepEqual(await s.getDefinitions('staging', 'credentials'), { 'uuid-1': { id: 'N1', name: 'OpenAI' } });
  } finally { await s.close(); }
});

test('withTransaction rolls back on error', async () => {
  const s = await freshStore();
  try {
    await assert.rejects(() => s.withTransaction(async (session) => {
      await s.putLive('workflows', [{ localId: 'a', name: 'A', body: {}, checksum: 'c' }], session);
      throw new Error('boom');
    }), /boom/);
    assert.deepEqual(await s.getLive('workflows'), [], 'insert rolled back');
  } finally { await s.close(); }
});

test('createSnapshot records a draft flag and message; a plain snapshot is not a draft', async () => {
  const s = await freshStore();
  try {
    const docs = [{ localId: 'w1', name: 'W', body: {}, checksum: 'c' }];
    await s.withTransaction((session) => s.createSnapshot('workflows', 'v1', docs, 'b1', session, 'wip', true));
    await s.withTransaction((session) => s.createSnapshot('workflows', 'v2', docs, 'b2', session));
    const [v1, v2] = await s.listVersions('workflows');
    assert.deepEqual([v1.draft, v1.message], [true, 'wip']);
    assert.deepEqual([v2.draft, v2.message], [false, undefined]);
  } finally { await s.close(); }
});

test('a nested withTransaction joins the outer one; a throw rolls the whole transaction back', async () => {
  const s = await freshStore();
  try {
    await assert.rejects(() => s.withTransaction(async (outer) => {
      await s.putLive('prompts', [{ localId: 'p1', name: 'P', body: {}, checksum: 'c' }], outer);
      await s.withTransaction((inner) => s.putLive('prompts', [{ localId: 'p2', name: 'P2', body: {}, checksum: 'c' }], inner)); // joins, no second BEGIN
      throw new Error('boom');
    }), /boom/);
    assert.deepEqual(await s.getLive('prompts'), [], 'both writes rolled back');
    // and the store is usable afterwards (txDepth reset)
    await s.withTransaction((session) => s.putLive('prompts', [{ localId: 'p3', name: 'P3', body: {}, checksum: 'c' }], session));
    assert.equal((await s.getLive('prompts')).length, 1);
  } finally { await s.close(); }
});

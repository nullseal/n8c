import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/store/memory.ts';

test('upsertLive merges by localId and keeps existing docs', async () => {
  const s = new MemoryStore();
  await s.withTransaction((ses) => s.putLive('prompts', [{ localId: 'a', name: 'A', body: { v: 1 }, checksum: 'c1' }], ses));
  await s.withTransaction((ses) => s.upsertLive('prompts', [{ localId: 'b', name: 'B', body: { v: 2 }, checksum: 'c2' }], ses));
  const live = await s.getLive('prompts');
  assert.equal(live.length, 2);
  await s.withTransaction((ses) => s.upsertLive('prompts', [{ localId: 'a', name: 'A2', body: { v: 9 }, checksum: 'c9' }], ses));
  const live2 = await s.getLive('prompts');
  assert.equal(live2.length, 2);
  assert.equal(live2.find((d) => d.localId === 'a')?.checksum, 'c9');
});

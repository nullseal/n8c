import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../src/store/memory.ts';
import { prompt } from '../src/entities/prompt.ts';
import { pullEntity } from '../src/engine/pull.ts';
import { exportDocs } from '../src/engine/transfer.ts';
import { checksum } from '../src/checksum.ts';

function ctx() { return { env: 'test', encrypted: false, getDefinitions: async () => ({}) } as any; }

async function setLive(store: MemoryStore, body: unknown) {
  await store.withTransaction((s) =>
    store.putLive('prompts', [{ localId: 'p1', name: 'g', body, checksum: checksum(body) }], s));
}

test('pull dedups against ANY existing version, not just the newest', async () => {
  const store = new MemoryStore();
  await setLive(store, { v: 'A' }); await pullEntity(store, prompt, '/tmp', ctx());
  await setLive(store, { v: 'B' }); await pullEntity(store, prompt, '/tmp', ctx());
  assert.equal((await store.listVersions('prompts')).length, 2);

  // back to state A: matches version 1 (which is NOT the newest) -> must dedup
  await setLive(store, { v: 'A' });
  const r = await pullEntity(store, prompt, '/tmp', ctx());
  assert.equal(r.deduped, true);
  assert.equal(r.versionId, undefined);
  assert.equal((await store.listVersions('prompts')).length, 2);
});

test('pull returns the pulled docs (new AND deduped) so export never re-reads the store', async () => {
  const store = new MemoryStore();
  await setLive(store, { v: 'A' });
  const first = await pullEntity(store, prompt, '/tmp', ctx());
  assert.equal(first.deduped, false);
  assert.equal(first.docs.length, 1, 'new pull returns docs');

  // re-pull identical state → deduped, but docs must STILL be returned so the CLI
  // can export straight from them (regression: a deduped pull used to re-read a
  // stored version, which crashed when that version had no docs).
  const second = await pullEntity(store, prompt, '/tmp', ctx());
  assert.equal(second.deduped, true);
  assert.deepEqual(second.docs, first.docs, 'deduped pull returns the same docs');
});

test('exportDocs renders straight from docs, no store lookup', async () => {
  const root = mkdtempSync(join(tmpdir(), 'n8c-'));
  try {
    const docs = [{ localId: 'p1', name: 'main', body: { key: 'main', content: 'hi' }, checksum: 'c1' }];
    const warns = await exportDocs(prompt, root, docs);
    assert.deepEqual(warns, []);
    const applyTs = readFileSync(join(root, 'prompts', 'p1', 'apply.ts'), 'utf8');
    assert.match(applyTs, /"key": "main"/);
    assert.ok(existsSync(join(root, 'prompts', 'p1', 'metadata.json')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('pull marks the pulled version active but never changes live docs', async () => {
  const store = new MemoryStore();
  await setLive(store, { v: 'A' });
  const r = await pullEntity(store, prompt, '/tmp', ctx());

  const live = await store.getLive('prompts');
  assert.deepEqual(live[0].body, { v: 'A' }, 'live must be untouched by pull');
  const versions = await store.listVersions('prompts');
  assert.equal(versions.filter((v) => v.isActive).length, 1, 'exactly one active version after pull');
  assert.equal(versions.find((v) => v.isActive)!.versionId, r.versionId, 'the just-pulled version is active');
});

test('re-pull that dedups re-marks the matching version active', async () => {
  const store = new MemoryStore();
  await setLive(store, { v: 'A' }); const a = await pullEntity(store, prompt, '/tmp', ctx());
  await setLive(store, { v: 'B' }); await pullEntity(store, prompt, '/tmp', ctx());
  // back to A: dedups to version 1, which must become active again
  await setLive(store, { v: 'A' });
  const r = await pullEntity(store, prompt, '/tmp', ctx());
  assert.equal(r.deduped, true);
  const versions = await store.listVersions('prompts');
  assert.equal(versions.filter((v) => v.isActive).length, 1);
  assert.equal(versions.find((v) => v.isActive)!.versionId, a.versionId, 'matching (older) version re-activated');
});

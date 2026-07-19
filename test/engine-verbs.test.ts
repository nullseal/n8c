import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../src/store/memory.ts';
import { prompt } from '../src/entities/prompt.ts';
import { writeEntity } from '../src/layout.ts';
import { applyEntity } from '../src/engine/apply.ts';
import { restoreEntity } from '../src/engine/restore.ts';
import { pullEntity } from '../src/engine/pull.ts';
import { exportVersion, importDir } from '../src/engine/transfer.ts';
import { generateEntity } from '../src/engine/generate.ts';

function ctx() { return { env: 'test', encrypted: false, getDefinitions: async () => ({}) } as any; }

test('generate scaffolds a new entity with uuid + apply.ts', () => {
  const root = mkdtempSync(join(tmpdir(), 'n8c-'));
  try {
    const g = generateEntity(root, 'prompts', {});
    assert.match(g.localId, /[0-9a-f-]{36}/);
    assert.ok(existsSync(join(g.dir, 'apply.ts')));
    assert.ok(existsSync(join(g.dir, 'metadata.json')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('restore reactivates an old version and overrides live', async () => {
  const root = mkdtempSync(join(tmpdir(), 'n8c-'));
  try {
    const store = new MemoryStore();
    writeEntity(root, 'prompts', 'p1', { name: 'greet' }, { key: 'greet', content: 'v1' });
    const a1 = await applyEntity(store, prompt, root, ctx(), { dry: false });
    writeEntity(root, 'prompts', 'p1', { name: 'greet' }, { key: 'greet', content: 'v2' });
    await applyEntity(store, prompt, root, ctx(), { dry: false });
    await restoreEntity(store, prompt, ctx(), a1.versionId!);
    const live = await store.getLive('prompts');
    assert.deepEqual(live[0].body, { key: 'greet', content: 'v1' });
    assert.equal((await store.listVersions('prompts')).find((v) => v.isActive)?.versionId, a1.versionId);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('pull for prompts snapshots current live without server', async () => {
  const store = new MemoryStore();
  await store.withTransaction((s) => store.putLive('prompts', [{ localId: 'p1', name: 'g', body: { key: 'g' }, checksum: 'c' }], s));
  const r = await pullEntity(store, prompt, '/tmp', ctx());
  assert.equal(r.count, 1);
  assert.equal((await store.listVersions('prompts')).length, 1);
});

test('export then import round-trips a version', async () => {
  const root = mkdtempSync(join(tmpdir(), 'n8c-'));
  try {
    const store = new MemoryStore();
    writeEntity(root, 'prompts', 'p1', { name: 'greet' }, { key: 'greet', content: 'hi' });
    const a = await applyEntity(store, prompt, root, ctx(), { dry: false });
    const root2 = mkdtempSync(join(tmpdir(), 'n8c-'));
    await exportVersion(store, prompt, root2, a.versionId!);
    assert.ok(existsSync(join(root2, 'prompts', 'p1', 'apply.ts')));
    const store2 = new MemoryStore();
    const imp = await importDir(store2, prompt, root2, ctx());
    assert.equal((await store2.listVersions('prompts')).length, 1);
    assert.deepEqual(await store2.getVersion('prompts', imp.versionId), await store.getVersion('prompts', a.versionId!));
    rmSync(root2, { recursive: true, force: true });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

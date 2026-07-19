import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../src/store/memory.ts';
import { prompt } from '../src/entities/prompt.ts';
import { writeEntity } from '../src/layout.ts';
import { planApply, applyEntity } from '../src/engine/apply.ts';

function ctx() { return { env: 'test', encrypted: false, getDefinitions: async () => ({}) } as any; }

test('apply after a snapshot-but-empty-live (pull) reactivates the matching version (no dup)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'n8c-'));
  try {
    writeEntity(root, 'prompts', 'p1', { name: 'greet' }, { key: 'greet', content: 'hi' });
    const store = new MemoryStore();

    // 1st apply establishes version v1 (active) + live.
    const a1 = await applyEntity(store, prompt, root, ctx(), { dry: false });
    // simulate a pull-style divergence: live cleared, snapshot v1 remains.
    await store.withTransaction((s) => store.putLive('prompts', [], s));

    // 2nd apply: 'new' vs (empty) live, but content matches v1 → no new version,
    // v1 is reactivated and returned (not "no changes").
    const a2 = await applyEntity(store, prompt, root, ctx(), { dry: false });
    assert.equal(a2.plan[0].status, 'new', 'new relative to the empty live');
    assert.equal(a2.versionId, a1.versionId, 'reactivates the matching version');
    assert.equal((await store.listVersions('prompts')).length, 1, 'no duplicate version');
    assert.equal((await store.listVersions('prompts')).find((v) => v.isActive)?.versionId, a1.versionId);
    assert.equal((await store.getLive('prompts')).length, 1, 'live restored');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('apply creates live + one snapshot; re-apply is identical and dedups', async () => {
  const root = mkdtempSync(join(tmpdir(), 'n8c-'));
  try {
    writeEntity(root, 'prompts', 'p1', { name: 'greet' }, { key: 'greet', content: 'hi' });
    const store = new MemoryStore();

    const r1 = await applyEntity(store, prompt, root, ctx(), { dry: false });
    assert.equal(r1.plan[0].status, 'new');
    assert.equal((await store.getLive('prompts')).length, 1);
    assert.equal((await store.listVersions('prompts')).length, 1);

    const r2 = await applyEntity(store, prompt, root, ctx(), { dry: false });
    assert.equal(r2.plan[0].status, 'identical');
    assert.equal((await store.listVersions('prompts')).length, 1); // dedup: no new version
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('dry run writes nothing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'n8c-'));
  try {
    writeEntity(root, 'prompts', 'p1', { name: 'greet' }, { key: 'greet', content: 'hi' });
    const store = new MemoryStore();
    const plan = await planApply(store, prompt, root, ctx());
    assert.equal(plan[0].status, 'new');
    await applyEntity(store, prompt, root, ctx(), { dry: true });
    assert.equal((await store.getLive('prompts')).length, 0);
    assert.equal((await store.listVersions('prompts')).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

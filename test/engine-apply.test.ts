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

test('diffNodes: nodes keyed by name when they have no id, and missing bodies/nodes lists count as empty', async () => {
  const { diffNodes } = await import('../src/engine/apply.ts');
  assert.deepEqual(diffNodes(undefined, undefined), []);
  assert.deepEqual(diffNodes({}, { nodes: [] }), []);
  const rows = diffNodes(
    { nodes: [{ name: 'OnlyName', parameters: { a: 1 } }, { id: 'only-id', parameters: {} }] },
    { nodes: [{ name: 'OnlyName', parameters: { a: 1 } }, { name: 'Gone' }, { id: 'gone-id' }] },
  );
  const by = (id: string) => rows.find((r) => r.id === id)!;
  assert.equal(by('OnlyName').status, 'identical');
  assert.deepEqual([by('only-id').name, by('only-id').status], ['only-id', 'new'], 'name falls back to the id');
  assert.equal(by('Gone').status, 'removed');
  assert.equal(by('gone-id').status, 'removed');
});

test('planApply: a nameless entity is named by its localId, and a new workflow lists its nodes as new', async () => {
  const { workflow } = await import('../src/entities/workflow.ts');
  const root = mkdtempSync(join(tmpdir(), 'n8c-'));
  try {
    writeEntity(root, 'workflows', 'wf-1', {}, { name: 'W', nodes: [{ id: 'n1', name: 'A', parameters: {} }], connections: {} });
    const store = new MemoryStore();
    const plan = await planApply(store, workflow, root, ctx());
    assert.equal(plan.length, 1);
    assert.equal(plan[0].status, 'new');
    assert.deepEqual(plan[0].nodes!.map((n) => [n.id, n.status]), [['n1', 'new']]);
    const r = await applyEntity(store, workflow, root, ctx(), { dry: false });
    assert.equal((await store.getLive('workflows'))[0].name, 'wf-1', 'no metadata.name → localId');
    assert.ok(r.versionId);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

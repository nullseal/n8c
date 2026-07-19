import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../src/store/memory.ts';
import { prompt } from '../src/entities/prompt.ts';
import { writeEntity } from '../src/layout.ts';
import { applyEntity } from '../src/engine/apply.ts';

function ctx() { return { env: 'test', encrypted: false, getDefinitions: async () => ({}) } as any; }

test('draft snapshots without touching live or active', async () => {
  const root = mkdtempSync(join(tmpdir(), 'n8c-'));
  try {
    writeEntity(root, 'prompts', 'p1', { name: 'greet' }, { key: 'greet', content: 'v1' });
    const store = new MemoryStore();
    await applyEntity(store, prompt, root, ctx(), { dry: false, draft: true });

    assert.equal((await store.getLive('prompts')).length, 0, 'draft must not write live');
    const versions = await store.listVersions('prompts');
    assert.equal(versions.length, 1);
    assert.equal(versions[0].draft, true);
    assert.equal(versions.some((v) => v.isActive), false, 'draft must not mark active');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a later normal apply publishes (live + active)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'n8c-'));
  try {
    writeEntity(root, 'prompts', 'p1', { name: 'greet' }, { key: 'greet', content: 'v1' });
    const store = new MemoryStore();
    await applyEntity(store, prompt, root, ctx(), { dry: false, draft: true });
    await applyEntity(store, prompt, root, ctx(), { dry: false });
    assert.equal((await store.getLive('prompts')).length, 1);
    assert.equal((await store.listVersions('prompts')).some((v) => v.isActive), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../src/store/memory.ts';
import { prompt } from '../src/entities/prompt.ts';
import { writeEntity } from '../src/layout.ts';
import { applyEntity } from '../src/engine/apply.ts';

test('apply stores the message on the version', async () => {
  const root = mkdtempSync(join(tmpdir(), 'n8c-'));
  try {
    writeEntity(root, 'prompts', 'p1', { name: 'greet' }, { key: 'greet', content: 'hi' });
    const store = new MemoryStore();
    await applyEntity(store, prompt, root, { env: 'test', encrypted: false, getDefinitions: async () => ({}) } as any, { dry: false, message: 'first cut' });
    assert.equal((await store.listVersions('prompts'))[0].message, 'first cut');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

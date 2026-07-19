import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../src/store/memory.ts';
import { workflow } from '../src/entities/workflow.ts';
import { applyEntity } from '../src/engine/apply.ts';

function ctx() { return { env: 'test', encrypted: false, getDefinitions: async () => ({}) } as any; }

test('workflow apply upserts node prompt.ts into prompts live', async () => {
  const root = mkdtempSync(join(tmpdir(), 'n8c-'));
  try {
    const na = join(root, 'workflows', 'w1', 'nodes', 'n1');
    mkdirSync(na, { recursive: true });
    writeFileSync(join(root, 'workflows', 'w1', 'metadata.json'), JSON.stringify({ name: 'flow' }));
    writeFileSync(join(root, 'workflows', 'w1', 'apply.ts'), 'export default {};\n');
    writeFileSync(join(na, 'metadata.json'), JSON.stringify({ name: 'LLM', type: 'x', typeVersion: 1, position: [0, 0] }));
    writeFileSync(join(na, 'apply.ts'), 'export default {};\n');
    writeFileSync(join(na, 'prompt.ts'), 'export default { key: "llm_sys", content: "hi" };\n');

    const store = new MemoryStore();
    await applyEntity(store, workflow, root, ctx(), { dry: false });
    const prompts = await store.getLive('prompts');
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].localId, 'llm_sys');
    assert.deepEqual((prompts[0].body as any), { key: 'llm_sys', content: 'hi' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('duplicate prompt key across nodes throws', async () => {
  const root = mkdtempSync(join(tmpdir(), 'n8c-'));
  try {
    for (const n of ['n1', 'n2']) {
      const nd = join(root, 'workflows', 'w1', 'nodes', n);
      mkdirSync(nd, { recursive: true });
      writeFileSync(join(nd, 'metadata.json'), JSON.stringify({ name: n, type: 'x', typeVersion: 1, position: [0, 0] }));
      writeFileSync(join(nd, 'apply.ts'), 'export default {};\n');
      writeFileSync(join(nd, 'prompt.ts'), 'export default { key: "dup", content: "x" };\n');
    }
    writeFileSync(join(root, 'workflows', 'w1', 'metadata.json'), JSON.stringify({ name: 'flow' }));
    writeFileSync(join(root, 'workflows', 'w1', 'apply.ts'), 'export default {};\n');
    const store = new MemoryStore();
    await assert.rejects(() => applyEntity(store, workflow, root, ctx(), { dry: false }), /duplicate prompt key dup/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

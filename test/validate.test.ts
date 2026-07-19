import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../src/store/memory.ts';
import { validateAll } from '../src/engine/validate.ts';

function ctx(store: MemoryStore) {
  return { env: 'test', encrypted: false, getDefinitions: (k: string) => store.getDefinitions('test', k) } as any;
}

test('validateAll flags a missing credential mapping', async () => {
  const root = mkdtempSync(join(tmpdir(), 'n8c-'));
  try {
    const na = join(root, 'workflows', 'w1', 'nodes', 'n1');
    mkdirSync(na, { recursive: true });
    writeFileSync(join(root, 'workflows', 'w1', 'metadata.json'), JSON.stringify({ name: 'flow' }));
    writeFileSync(join(root, 'workflows', 'w1', 'apply.ts'), 'export default {};\n');
    writeFileSync(join(na, 'metadata.json'), JSON.stringify({ name: 'n', type: 'x', typeVersion: 1, position: [0, 0] }));
    writeFileSync(join(na, 'apply.ts'), 'export default {};\n');
    writeFileSync(join(na, 'credentials.ts'), 'export default { openAiApi: "missing-cred" };\n');
    const store = new MemoryStore();
    const problems = await validateAll(root, ctx(store), store);
    assert.ok(problems.some((p) => p.includes('missing-cred')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('validateAll passes when credential mapping exists', async () => {
  const root = mkdtempSync(join(tmpdir(), 'n8c-'));
  try {
    const na = join(root, 'workflows', 'w1', 'nodes', 'n1');
    mkdirSync(na, { recursive: true });
    writeFileSync(join(root, 'workflows', 'w1', 'metadata.json'), JSON.stringify({ name: 'flow' }));
    writeFileSync(join(root, 'workflows', 'w1', 'apply.ts'), 'export default {};\n');
    writeFileSync(join(na, 'metadata.json'), JSON.stringify({ name: 'n', type: 'x', typeVersion: 1, position: [0, 0] }));
    writeFileSync(join(na, 'apply.ts'), 'export default {};\n');
    writeFileSync(join(na, 'credentials.ts'), 'export default { openAiApi: "cred-1" };\n');
    const store = new MemoryStore();
    await store.withTransaction((s) => store.putDefinitions('test', 'credentials', { 'cred-1': { id: 'x', name: 'y' } }, s));
    const problems = await validateAll(root, ctx(store), store);
    assert.deepEqual(problems, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

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

// A flat workflow (apply.ts, no nodes/ dir) carries its name TWICE: metadata.json
// drives every display, apply.ts's body is what gets pushed to n8n. Renaming only
// one of them is the trap — `plan` would print the new name while n8n kept the old.
function flatWorkflow(root: string, metaName: string, bodyName: string) {
  const dir = join(root, 'workflows', 'w1');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'metadata.json'), JSON.stringify({ name: metaName }));
  writeFileSync(join(dir, 'apply.ts'), `export default () => ({ name: ${JSON.stringify(bodyName)}, nodes: [], connections: {} });\n`);
}

test('validateAll flags a workflow renamed in metadata.json but not apply.ts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'n8c-'));
  try {
    flatWorkflow(root, 'New Name', 'Old Name');
    const store = new MemoryStore();
    const problems = await validateAll(root, ctx(store), store);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /New Name/);
    assert.match(problems[0], /Old Name/);
    assert.match(problems[0], /apply\.ts/, 'names the file that actually reaches n8n');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('validateAll is quiet when both files agree on the name', async () => {
  const root = mkdtempSync(join(tmpdir(), 'n8c-'));
  try {
    flatWorkflow(root, 'Same Name', 'Same Name');
    const store = new MemoryStore();
    assert.deepEqual(await validateAll(root, ctx(store), store), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('validateAll ignores a body that sets no name at all', async () => {
  const root = mkdtempSync(join(tmpdir(), 'n8c-'));
  try {
    const dir = join(root, 'workflows', 'w1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'metadata.json'), JSON.stringify({ name: 'Only In Metadata' }));
    writeFileSync(join(dir, 'apply.ts'), 'export default () => ({ nodes: [], connections: {} });\n');
    const store = new MemoryStore();
    assert.deepEqual(await validateAll(root, ctx(store), store), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

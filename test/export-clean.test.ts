import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../src/store/memory.ts';
import { workflow } from '../src/entities/workflow.ts';
import { exportVersion } from '../src/engine/transfer.ts';

test('export wipes the entity folder first (drops a stale nodes/ split)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'n8c-'));
  try {
    const store = new MemoryStore();
    const body = { name: 'flow', nodes: [{ id: 'na', name: 'A', type: 'x', typeVersion: 1, position: [0, 0], parameters: {} }], connections: {} };
    await store.withTransaction((s) => store.createSnapshot('workflows', 'v1', [{ localId: 'w1', name: 'flow', body, checksum: 'c' }], 'b', s));

    // pre-existing stale content in the destination folder
    const dir = join(root, 'workflows', 'w1');
    mkdirSync(join(dir, 'nodes', 'old'), { recursive: true });
    writeFileSync(join(dir, 'nodes', 'old', 'apply.ts'), 'export default {};\n');
    writeFileSync(join(dir, 'stale.txt'), 'leftover');

    await exportVersion(store, workflow, root, 'v1');

    assert.ok(!existsSync(join(dir, 'nodes')), 'stale nodes/ removed');
    assert.ok(!existsSync(join(dir, 'stale.txt')), 'stale file removed');
    assert.deepEqual(readdirSync(dir).sort(), ['apply.ts', 'metadata.json'], 'only fresh files remain');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('exportVersion throws when the version has no docs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'n8c-'));
  try {
    await assert.rejects(() => exportVersion(new MemoryStore(), workflow, root, 'nope'), /version nope not found for workflows/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('exportDocs: a credential of an unlisted type gets the generic apiKey hint; a workflow body without nodes still exports', async () => {
  const { exportDocs } = await import('../src/engine/transfer.ts');
  const { credential } = await import('../src/entities/credential.ts');
  const root = mkdtempSync(join(tmpdir(), 'n8c-'));
  try {
    await exportDocs(credential, root, [{ localId: 'c1', name: 'Odd', body: { name: 'Odd', type: 'fooApi' }, checksum: 'x' }]);
    assert.match(readFileSync(join(root, 'credentials', 'c1', 'apply.ts'), 'utf8'), /\/\/ data: \{ apiKey: process\.env\.MY_TOKEN \}/);
    await exportDocs(workflow, root, [{ localId: 'w1', name: 'Shell', body: { name: 'Shell' }, checksum: 'x' }], { getDefinitions: async () => ({}) } as any);
    assert.ok(existsSync(join(root, 'workflows', 'w1', 'apply.ts')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('exportDocs: credential refs without an id are ignored; an unmapped ref on a nameless workflow names it by localId', async () => {
  const { exportDocs } = await import('../src/engine/transfer.ts');
  const root = mkdtempSync(join(tmpdir(), 'n8c-'));
  const ctx = { getDefinitions: async () => ({}) } as any;
  try {
    // an id-less ref is skipped (nothing to relink) → exports fine
    await exportDocs(workflow, root, [{ localId: 'w1', name: 'Ok', checksum: 'x',
      body: { name: 'Ok', nodes: [{ id: 'n', name: 'N', credentials: { slackApi: { name: 'no id' } } }] } }], ctx);
    assert.ok(existsSync(join(root, 'workflows', 'w1', 'apply.ts')));
    // an unmapped ref on a nameless workflow doc: message uses the localId and omits the "(name)" suffix
    await assert.rejects(() => exportDocs(workflow, root, [{ localId: 'w2', name: undefined as any, checksum: 'x',
      body: { nodes: [{ id: 'n', name: 'N', credentials: { slackApi: { id: 'RAW1' } } }] } }], ctx),
      (e: Error) => e.message.startsWith('workflow "w2": credential RAW1 has no localId mapping.'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

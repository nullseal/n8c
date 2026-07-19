import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
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

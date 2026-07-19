import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readEntity } from '../src/layout.ts';

test('workflow readEntity assembles nodes and resolves connections by nodeId', async () => {
  const root = mkdtempSync(join(tmpdir(), 'n8c-'));
  try {
    const wf = join(root, 'workflows', 'w1');
    mkdirSync(join(wf, 'nodes', 'na'), { recursive: true });
    mkdirSync(join(wf, 'nodes', 'nb'), { recursive: true });
    writeFileSync(join(wf, 'metadata.json'), JSON.stringify({
      name: 'flow', connections: { na: { main: [[{ node: 'nb', type: 'main', index: 0 }]] } },
    }));
    writeFileSync(join(wf, 'apply.ts'), 'export default {};\n');
    writeFileSync(join(wf, 'nodes', 'na', 'metadata.json'), JSON.stringify({ name: 'Start', type: 'n8n-nodes-base.set', typeVersion: 1, position: [0, 0] }));
    writeFileSync(join(wf, 'nodes', 'na', 'apply.ts'), 'export default { value: 1 };\n');
    writeFileSync(join(wf, 'nodes', 'nb', 'metadata.json'), JSON.stringify({ name: 'End', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [1, 0] }));
    writeFileSync(join(wf, 'nodes', 'nb', 'apply.ts'), 'export default {};\n');

    const { body } = await readEntity(root, 'workflows', 'w1') as any;
    assert.equal(body.nodes.length, 2);
    assert.equal(body.nodes[0].name, 'Start');
    assert.deepEqual(body.nodes[0].parameters, { value: 1 });
    // connections keyed by nodeId 'na' resolve to node NAME 'Start' -> 'End'
    assert.ok(body.connections.Start);
    assert.equal(body.connections.Start.main[0][0].node, 'End');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

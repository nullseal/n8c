import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { materializeWorkflowSource } from '../src/engine/materialize.ts';
import { readEntity } from '../src/layout.ts';

function writeWf(root: string, body: any): void {
  const dir = join(root, 'workflows', 'w1');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'metadata.json'), JSON.stringify({ name: body.name }));
  writeFileSync(join(dir, 'apply.ts'), materializeWorkflowSource(body));
}

test('materialize emits named-const nodes + jsCode template literal', () => {
  const body = {
    name: 'flow', settings: { executionOrder: 'v1' },
    nodes: [{ id: 'na', name: 'Start', type: 'n8n-nodes-base.code', typeVersion: 2, position: [0, 0], parameters: { mode: 'runOnceForAllItems', jsCode: 'return items;' } }],
    connections: {},
  };
  const src = materializeWorkflowSource(body);
  assert.match(src, /const startCode = `return items;`;/);
  assert.match(src, /const start = \{/);
  assert.match(src, /"jsCode": startCode/);
  assert.match(src, /export default \(\): Workflow => \(\{/);
  assert.match(src, /^import type \{ Workflow \} from '\.\.\/\.\.\/n8c\.types\.ts';/, 'editor-only type import (erasable)');
  assert.match(src, /"nodes": \[start\]/);
});

test('reserved-word node names get a valid identifier (If/Switch)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'n8c-'));
  try {
    const body = {
      name: 'flow',
      nodes: [
        { id: 'na', name: 'If', type: 'n8n-nodes-base.if', typeVersion: 1, position: [0, 0], parameters: {} },
        { id: 'nb', name: 'Switch', type: 'n8n-nodes-base.switch', typeVersion: 1, position: [1, 0], parameters: {} },
      ],
      connections: {},
    };
    writeWf(root, body);
    // would throw "Expected identifier" if slug were `if`/`switch`
    const r: any = await readEntity(root, 'workflows', 'w1');
    assert.deepEqual(r.body.nodes.map((n: any) => n.name), ['If', 'Switch']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('materialize → readEntity round-trips the workflow', async () => {
  const root = mkdtempSync(join(tmpdir(), 'n8c-'));
  try {
    const body = {
      name: 'flow', settings: { executionOrder: 'v1' },
      nodes: [
        { id: 'na', name: 'Start', type: 'n8n-nodes-base.code', typeVersion: 2, position: [0, 0], parameters: { jsCode: 'const s = `hi ${x}`;\nreturn [{ json: { s } }];' } },
        { id: 'nb', name: 'End', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [300, 0], parameters: {} },
      ],
      connections: { Start: { main: [[{ node: 'End', type: 'main', index: 0 }]] } },
    };
    writeWf(root, body);
    const r: any = await readEntity(root, 'workflows', 'w1');
    assert.deepEqual(r.body, body); // exact round-trip incl. template-literal jsCode
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('materialize: nameless / symbol-only / digit-led / duplicate node names all get unique valid identifiers', () => {
  const src = materializeWorkflowSource({ nodes: [
    { id: '1' },                // no name at all
    { id: '2', name: '' },      // empty name
    { id: '3', name: '***' },   // nothing left after stripping symbols
    { id: '4', name: '3rd step' },
    { id: '5', name: 'dup' },
    { id: '6', name: 'dup' },
  ] });
  for (const decl of ['const node =', 'const node_2 =', 'const node_3 =', 'const n_3rd_step =', 'const dup =', 'const dup_2 =']) {
    assert.ok(src.includes(decl), `declares ${decl}`);
  }
  assert.ok(src.includes('"nodes": [node, node_2, node_3, n_3rd_step, dup, dup_2]'), 'wires all slugs into nodes');
});

test('materialize: a missing body yields an empty workflow with no nodes and empty connections', () => {
  const src = materializeWorkflowSource(undefined);
  assert.ok(src.includes('"nodes": []'));
  assert.ok(src.includes('"connections": {}'));
});

test('materialize: a body without nodes still emits the workflow shell', () => {
  const src = materializeWorkflowSource({ name: 'Shell' });
  assert.ok(src.includes('"name": "Shell"') && src.includes('"nodes": []'));
});

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

// A node's code.ts is a module (`export default …`) or a raw body; routing looks at real code only.
async function jsCodeOf(codeTs: string): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'n8c-'));
  try {
    const node = join(root, 'workflows', 'w1', 'nodes', 'na');
    mkdirSync(node, { recursive: true });
    writeFileSync(join(root, 'workflows', 'w1', 'metadata.json'), JSON.stringify({ name: 'flow', connections: {} }));
    writeFileSync(join(root, 'workflows', 'w1', 'apply.ts'), 'export default {};\n');
    writeFileSync(join(node, 'metadata.json'), JSON.stringify({ name: 'Code', type: 'n8n-nodes-base.code', typeVersion: 2, position: [0, 0] }));
    writeFileSync(join(node, 'apply.ts'), 'export default {};\n');
    writeFileSync(join(node, 'code.ts'), codeTs);
    const { body } = await readEntity(root, 'workflows', 'w1') as any;
    return body.nodes[0].parameters.jsCode;
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('code.ts raw body: a comment line starting with export is not a module export', async () => {
  const src = '/*\nexport results to the sheet\n*/\nreturn [];\n';
  assert.equal(await jsCodeOf(src), src.trimEnd());
});

test('code.ts raw body: a template line starting with export is not a module export', async () => {
  const src = 'const t = `a\nexport b`;\nreturn [{ json: { t } }];\n';
  assert.equal(await jsCodeOf(src), src.trimEnd());
});

test('code.ts module form: export default still yields its value', async () => {
  assert.equal(await jsCodeOf('export default () => `return 1`;\n'), 'return 1');
});

test('code.ts module form: a template line starting with export does not hide the real export', async () => {
  assert.equal(await jsCodeOf('export default () => `a\nexport b\nreturn 1`;\n'), 'a\nexport b\nreturn 1');
});

// An exploded workflow with nodes na ('Start'), nb ('Middle') and nc ('End');
// metadata.json connects Start → Middle.
function threeNodes(root: string): string {
  const wf = join(root, 'workflows', 'w1');
  mkdirSync(wf, { recursive: true });
  writeFileSync(join(wf, 'metadata.json'), JSON.stringify({
    name: 'flow', connections: { na: { main: [[{ node: 'nb', type: 'main', index: 0 }]] } },
  }));
  writeFileSync(join(wf, 'apply.ts'), 'export default {};\n');
  for (const [id, name] of [['na', 'Start'], ['nb', 'Middle'], ['nc', 'End']]) {
    mkdirSync(join(wf, 'nodes', id), { recursive: true });
    writeFileSync(join(wf, 'nodes', id, 'metadata.json'), JSON.stringify({ name, type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [0, 0] }));
    writeFileSync(join(wf, 'nodes', id, 'apply.ts'), 'export default {};\n');
  }
  return wf;
}

test("a node's connection.ts replaces its metadata.json connections", async () => {
  const root = mkdtempSync(join(tmpdir(), 'n8c-'));
  try {
    const wf = threeNodes(root);
    writeFileSync(join(wf, 'nodes', 'na', 'connection.ts'), "export default { main: [[{ node: 'nc', type: 'main', index: 0 }]] };\n");
    const { body } = await readEntity(root, 'workflows', 'w1') as any;
    assert.deepEqual(body.connections, { Start: { main: [[{ node: 'End', type: 'main', index: 0 }]] } });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a node without credentials.ts keeps the credentials in its metadata.json', async () => {
  const root = mkdtempSync(join(tmpdir(), 'n8c-'));
  try {
    const wf = threeNodes(root);
    const credentials = { openAiApi: { id: 'cred-1', name: 'OpenAI' } };
    writeFileSync(join(wf, 'nodes', 'na', 'metadata.json'), JSON.stringify({ name: 'Start', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [0, 0], credentials }));
    const { body } = await readEntity(root, 'workflows', 'w1') as any;
    assert.deepEqual(body.nodes.find((n: any) => n.id === 'na').credentials, credentials);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readEntity } from '../src/layout.ts';
import { createEntity } from '../src/engine/generate.ts';

test('credentials.ts / prompt.ts may be async functions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'n8c-'));
  try {
    const na = join(root, 'workflows', 'w1', 'nodes', 'n1');
    mkdirSync(na, { recursive: true });
    writeFileSync(join(root, 'workflows', 'w1', 'metadata.json'), JSON.stringify({ name: 'flow' }));
    writeFileSync(join(root, 'workflows', 'w1', 'apply.ts'), 'export default {};\n');
    writeFileSync(join(na, 'metadata.json'), JSON.stringify({ name: 'LLM', type: 'x', typeVersion: 1, position: [0, 0] }));
    writeFileSync(join(na, 'apply.ts'), 'export default {};\n');
    writeFileSync(join(na, 'credentials.ts'), 'export default async () => ({ openAiApi: "cred-9" });\n');
    writeFileSync(join(na, 'prompt.ts'), 'export default function () { return { key: "k", content: "hi" }; }\n');

    const r: any = await readEntity(root, 'workflows', 'w1');
    assert.deepEqual(r.body.nodes[0].credentials, { openAiApi: { id: 'cred-9' } });
    assert.deepEqual(r.prompts[0], { localId: 'k', name: 'k', body: { key: 'k', content: 'hi' } });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('node credentials.ts + prompt.ts + id/notes marker', async () => {
  const root = mkdtempSync(join(tmpdir(), 'n8c-'));
  try {
    const wf = join(root, 'workflows', 'w1');
    const na = join(wf, 'nodes', 'node-aaa');
    mkdirSync(na, { recursive: true });
    writeFileSync(join(wf, 'metadata.json'), JSON.stringify({ name: 'flow', description: 'my flow' }));
    writeFileSync(join(wf, 'apply.ts'), 'export default {};\n');
    writeFileSync(join(na, 'metadata.json'), JSON.stringify({ name: 'LLM', type: 'x', typeVersion: 1, position: [0, 0] }));
    writeFileSync(join(na, 'apply.ts'), 'export default { model: "gpt-4o-mini" };\n');
    writeFileSync(join(na, 'credentials.ts'), 'export default { openAiApi: "cred-local-1" };\n');
    writeFileSync(join(na, 'prompt.ts'), 'export default { key: "llm_sys", content: "xin chao" };\n');

    const r: any = await readEntity(root, 'workflows', 'w1');
    const node = r.body.nodes[0];
    assert.equal(node.id, 'node-aaa');
    assert.equal(node.notes, 'n8c@node-aaa');
    assert.deepEqual(node.credentials, { openAiApi: { id: 'cred-local-1' } });
    assert.equal(r.body.description.includes('[n8c-managed]'), true);
    assert.equal(r.prompts.length, 1);
    assert.deepEqual(r.prompts[0], { localId: 'llm_sys', name: 'llm_sys', body: { key: 'llm_sys', content: 'xin chao' } });
    // prompt is NOT inlined onto the node
    assert.equal('parameters' in node, true);
    assert.equal(JSON.stringify(node).includes('xin chao'), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Comment-only companion files. Like most n8c projects (n8c never writes a
// package.json), these temp projects have no package.json saying "type": "module".
// Node then loads a .ts file with no `export` as CommonJS, so import() of a
// comment-only one yields `{ default: {} }`.

// One exploded workflow w1 holding node n1, plus the given files in n1's folder.
function oneNode(root: string, nodeMeta: object, files: Record<string, string>): void {
  const na = join(root, 'workflows', 'w1', 'nodes', 'n1');
  mkdirSync(na, { recursive: true });
  writeFileSync(join(root, 'workflows', 'w1', 'metadata.json'), JSON.stringify({ name: 'flow' }));
  writeFileSync(join(root, 'workflows', 'w1', 'apply.ts'), 'export default {};\n');
  writeFileSync(join(na, 'metadata.json'), JSON.stringify({ name: 'LLM', type: 'x', typeVersion: 1, position: [0, 0], ...nodeMeta }));
  writeFileSync(join(na, 'apply.ts'), 'export default {};\n');
  for (const [name, src] of Object.entries(files)) writeFileSync(join(na, name), src);
}

test('nodes scaffolded by `n8c create node` keep their metadata.json connections', async () => {
  const root = mkdtempSync(join(tmpdir(), 'n8c-'));
  try {
    const start = createEntity(root, 'node', { workflowId: 'w1', name: 'Start', nodeType: 'n8n-nodes-base.noOp' });
    const end = createEntity(root, 'node', { workflowId: 'w1', name: 'End', nodeType: 'n8n-nodes-base.noOp' });
    writeFileSync(join(root, 'workflows', 'w1', 'apply.ts'), 'export default {};\n');
    writeFileSync(join(root, 'workflows', 'w1', 'metadata.json'), JSON.stringify({
      name: 'flow', connections: { [start.localId]: { main: [[{ node: end.localId, type: 'main', index: 0 }]] } },
    }));
    const r: any = await readEntity(root, 'workflows', 'w1');
    assert.deepEqual(r.body.connections, { Start: { main: [[{ node: 'End', type: 'main', index: 0 }]] } });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a comment-only credentials.ts keeps the credentials in the node metadata.json', async () => {
  const root = mkdtempSync(join(tmpdir(), 'n8c-'));
  try {
    const credentials = { openAiApi: { id: 'cred-1', name: 'OpenAI' } };
    oneNode(root, { credentials }, { 'credentials.ts': "// export default { openAiApi: '<credentialLocalId>' };\n" });
    const r: any = await readEntity(root, 'workflows', 'w1');
    assert.deepEqual(r.body.nodes[0].credentials, credentials);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a comment-only prompt.ts adds no prompt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'n8c-'));
  try {
    oneNode(root, {}, { 'prompt.ts': "// export default { key: 'my_prompt', content: '...' };\n" });
    const r: any = await readEntity(root, 'workflows', 'w1');
    assert.deepEqual(r.prompts, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

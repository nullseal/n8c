import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readEntity } from '../src/layout.ts';

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

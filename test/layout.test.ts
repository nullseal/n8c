import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeEntity, readEntity, listEntityIds } from '../src/layout.ts';

test('writeEntity then readEntity round-trips body + metadata', async () => {
  const root = mkdtempSync(join(tmpdir(), 'n8c-'));
  try {
    writeEntity(root, 'prompts', 'p1', { name: 'greet' }, { key: 'greet', content: 'xin chào' });
    assert.deepEqual(listEntityIds(root, 'prompts'), ['p1']);
    const e = await readEntity(root, 'prompts', 'p1');
    assert.equal(e.metadata.name, 'greet');
    assert.deepEqual(e.body, { key: 'greet', content: 'xin chào' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('listEntityIds is empty when dir absent', () => {
  const root = mkdtempSync(join(tmpdir(), 'n8c-'));
  try { assert.deepEqual(listEntityIds(root, 'workflows'), []); }
  finally { rmSync(root, { recursive: true, force: true }); }
});

function explodedWf(root: string, codeSrc: string | null, wfMeta: any = { name: 'flow' }) {
  const wf = join(root, 'workflows', 'w1');
  mkdirSync(join(wf, 'nodes', 'na'), { recursive: true });
  writeFileSync(join(wf, 'metadata.json'), JSON.stringify(wfMeta));
  writeFileSync(join(wf, 'apply.ts'), 'export default {};\n');
  writeFileSync(join(wf, 'nodes', 'na', 'metadata.json'), JSON.stringify({ name: 'Code', type: 'n8n-nodes-base.code', typeVersion: 2, position: [0, 0] }));
  writeFileSync(join(wf, 'nodes', 'na', 'apply.ts'), 'export default {};\n');
  if (codeSrc !== null) writeFileSync(join(wf, 'nodes', 'na', 'code.ts'), codeSrc);
}

test('a comment-only Code node source does not set parameters.jsCode; real code does', async () => {
  const root = mkdtempSync(join(tmpdir(), 'n8c-'));
  try {
    explodedWf(root, '// nothing here yet\n/* block */\n   \n');
    const { body } = await readEntity(root, 'workflows', 'w1') as any;
    assert.equal('jsCode' in body.nodes[0].parameters, false);
    explodedWf(root, '// header\nreturn [{ json: { ok: true } }];\n');
    const again = await readEntity(root, 'workflows', 'w1') as any;
    assert.match(again.body.nodes[0].parameters.jsCode, /return \[\{ json: \{ ok: true \} \}\];/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('flat workflow: metadata.description passes through to the body unless the body has its own', async () => {
  const root = mkdtempSync(join(tmpdir(), 'n8c-'));
  try {
    const wf = join(root, 'workflows', 'flat');
    mkdirSync(wf, { recursive: true });
    writeFileSync(join(wf, 'metadata.json'), JSON.stringify({ name: 'f', description: 'from metadata' }));
    writeFileSync(join(wf, 'apply.ts'), "export default { name: 'f', nodes: [], connections: {} };\n");
    assert.equal(((await readEntity(root, 'workflows', 'flat')) as any).body.description, 'from metadata');
    writeFileSync(join(wf, 'apply.ts'), "export default { name: 'f', description: 'own', nodes: [], connections: {} };\n");
    assert.equal(((await readEntity(root, 'workflows', 'flat')) as any).body.description, 'own');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

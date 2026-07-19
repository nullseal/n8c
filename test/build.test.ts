import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSources } from '../src/engine/build.ts';
import { readEntity } from '../src/layout.ts';

test('buildSources inlines a unit, writes dist, maps target node', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'n8c-proj-'));
  try {
    const unit = join(cwd, 'src', 'greet');
    mkdirSync(unit, { recursive: true });
    writeFileSync(join(unit, 'metadata.json'), JSON.stringify({ target: 'node-xyz' }));
    writeFileSync(join(unit, 'helpers.ts'), 'export function hi(): string { return "xin chao"; }\n');
    writeFileSync(join(unit, 'code.ts'), "import { hi } from './helpers.ts';\nreturn [{ json: { msg: hi() } }];\n");

    const { codeByNode, units } = await buildSources(cwd);
    assert.deepEqual(units, ['greet']);
    assert.ok(existsSync(join(cwd, 'dist', 'greet.js')));
    assert.ok(codeByNode['node-xyz'].includes('function hi'));
    assert.ok(!/(^|\n)\s*(import|export)\b/.test(codeByNode['node-xyz']));
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('buildSources requires metadata.target', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'n8c-proj-'));
  try {
    const unit = join(cwd, 'src', 'bad');
    mkdirSync(unit, { recursive: true });
    writeFileSync(join(unit, 'metadata.json'), JSON.stringify({}));
    writeFileSync(join(unit, 'code.ts'), 'return [];\n');
    await assert.rejects(() => buildSources(cwd), /metadata\.target/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('readEntity injects built jsCode into the targeted node', async () => {
  const root = mkdtempSync(join(tmpdir(), 'n8c-root-'));
  try {
    const nd = join(root, 'workflows', 'w1', 'nodes', 'node-xyz');
    mkdirSync(nd, { recursive: true });
    writeFileSync(join(root, 'workflows', 'w1', 'metadata.json'), JSON.stringify({ name: 'flow' }));
    writeFileSync(join(root, 'workflows', 'w1', 'apply.ts'), 'export default {};\n');
    writeFileSync(join(nd, 'metadata.json'), JSON.stringify({ name: 'Code', type: 'n8n-nodes-base.code', typeVersion: 2, position: [0, 0] }));
    writeFileSync(join(nd, 'apply.ts'), 'export default { mode: "runOnceForAllItems" };\n');

    const r: any = await readEntity(root, 'workflows', 'w1', { 'node-xyz': 'return [{ json: {} }];' });
    const node = r.body.nodes[0];
    assert.equal(node.parameters.jsCode, 'return [{ json: {} }];');
    assert.equal(node.parameters.mode, 'runOnceForAllItems', 'other params preserved');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

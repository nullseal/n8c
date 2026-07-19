import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEntity } from '../src/engine/generate.ts';

test('create node requires workflowId and nests under it', () => {
  const root = mkdtempSync(join(tmpdir(), 'n8c-'));
  try {
    assert.throws(() => createEntity(root, 'node', { name: 'x' }), /workflow/);
    const g = createEntity(root, 'node', { name: 'LLM', nodeType: 'lmChatOpenAi', workflowId: 'w1' });
    assert.ok(g.dir.includes(join('workflows', 'w1', 'nodes')));
    assert.ok(existsSync(join(g.dir, 'apply.ts')));
    assert.ok(existsSync(join(g.dir, 'code.ts')), 'scaffolds code.ts stub');
    assert.ok(existsSync(join(g.dir, 'connection.ts')), 'scaffolds connection.ts stub');
    // stubs are commented → inert (no default export)
    assert.doesNotMatch(readFileSync(join(g.dir, 'code.ts'), 'utf8'), /^export default/m);
    assert.equal(JSON.parse(readFileSync(join(g.dir, 'metadata.json'), 'utf8')).type, 'lmChatOpenAi');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('create prompt writes key into metadata', () => {
  const root = mkdtempSync(join(tmpdir(), 'n8c-'));
  try {
    const g = createEntity(root, 'prompt', { name: 'greet', key: 'greet_sys' });
    assert.equal(JSON.parse(readFileSync(join(g.dir, 'metadata.json'), 'utf8')).key, 'greet_sys');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('create credential scaffolds a process.env secret, not a hard-coded token', () => {
  const root = mkdtempSync(join(tmpdir(), 'n8c-'));
  try {
    const g = createEntity(root, 'credential', { name: 'Shopify Admin', nodeType: 'httpHeaderAuth' });
    const apply = readFileSync(join(g.dir, 'apply.ts'), 'utf8');
    assert.match(apply, /process\.env\.SHOPIFY_ADMIN_TOKEN/); // reads the secret from .env at read time
    assert.doesNotMatch(apply, /shpat_/); // never a real secret
  } finally { rmSync(root, { recursive: true, force: true }); }
});

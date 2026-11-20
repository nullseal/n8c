import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEntity } from '../src/engine/generate.ts';
import { buildProgram } from '../src/cli.ts';

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

// The stubs point users at n8c commands, written as `n8c <command>`, so every one
// they name must exist. (Prose such as "n8c does not store it" names no command.)
test('the create node stubs name only n8c commands that exist', () => {
  const root = mkdtempSync(join(tmpdir(), 'n8c-'));
  try {
    const g = createEntity(root, 'node', { workflowId: 'w1' });
    const commands = new Set(buildProgram().commands.map((c) => c.name()));
    for (const file of readdirSync(g.dir)) {
      for (const [, cmd] of readFileSync(join(g.dir, file), 'utf8').matchAll(/`n8c ([a-z][\w-]*)/g)) {
        assert.ok(commands.has(cmd), `${file} points at \`n8c ${cmd}\`, which is not an n8c command`);
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// A node's prompt.ts is only validated: no command stores it (docs/ARCHITECTURE.md,
// diagram 12), so the stub must not promise that it reaches n8c_prompts.
test('the create node stub says a node prompt.ts is checked, not stored', () => {
  const root = mkdtempSync(join(tmpdir(), 'n8c-'));
  try {
    const g = createEntity(root, 'node', { workflowId: 'w1' });
    const hint = readFileSync(join(g.dir, 'connection.ts'), 'utf8').split('\n').find((l) => l.includes('prompt.ts'));
    assert.ok(hint, 'the stub still documents prompt.ts');
    assert.doesNotMatch(hint, /n8c_prompts|extracted/);
    assert.match(hint, /plan checks its key is unique; n8c does not store it/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('create prompt writes key into metadata', () => {
  const root = mkdtempSync(join(tmpdir(), 'n8c-'));
  try {
    const g = createEntity(root, 'prompt', { name: 'greet', key: 'greet_sys' });
    assert.equal(JSON.parse(readFileSync(join(g.dir, 'metadata.json'), 'utf8')).key, 'greet_sys');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('create credential: an empty --type defaults to httpHeaderAuth; an empty name still yields a CREDENTIAL_TOKEN variable', () => {
  const root = mkdtempSync(join(tmpdir(), 'n8c-'));
  try {
    const g = createEntity(root, 'credential', { name: '', nodeType: '' });
    const src = readFileSync(join(g.dir, 'apply.ts'), 'utf8');
    assert.match(src, /type: "httpHeaderAuth"/);
    assert.match(src, /process\.env\.CREDENTIAL_TOKEN/);
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

test('create rejects an unknown entity type', () => {
  const root = mkdtempSync(join(tmpdir(), 'n8c-'));
  try {
    assert.throws(() => createEntity(root, 'gizmo' as any, { name: 'x' }), /unknown entity type gizmo/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
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

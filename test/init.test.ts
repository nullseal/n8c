import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initProject } from '../src/engine/init.ts';
import { MemoryStore } from '../src/store/memory.ts';

test('initProject scaffolds config, dirs, env template, gitignore', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'n8c-init-'));
  try {
    const touched = initProject(cwd);
    assert.ok(touched.includes('n8c.config.json'));
    // init writes config/.env/gitignore only — no placeholder entity dirs
    assert.ok(!existsSync(join(cwd, 'n8c')), 'no entity dirs scaffolded (create/pull make them lazily)');
    assert.ok(existsSync(join(cwd, '.env')));
    assert.ok(existsSync(join(cwd, '.env.example')));
    assert.match(readFileSync(join(cwd, '.env.example'), 'utf8'), /N8C_CREDENTIAL_ENCRYPTION_KEY=/);
    const gi = readFileSync(join(cwd, '.gitignore'), 'utf8');
    assert.match(gi, /\.env\.\*/);
    assert.match(gi, /^dist\/$/m);
    assert.doesNotMatch(gi, /^n8c\/$/m, 'n8c/ is committed, not ignored');
    assert.match(readFileSync(join(cwd, 'n8c.config.json'), 'utf8'), /"database":\s*"mongodb"/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('initProject is idempotent (second run touches nothing)', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'n8c-init-'));
  try {
    initProject(cwd);
    assert.deepEqual(initProject(cwd), []);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('initProject never clobbers an existing real .env', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'n8c-init-'));
  try {
    writeFileSync(join(cwd, '.env'), 'MONGO_URI=secret-do-not-touch\n');
    initProject(cwd);
    assert.match(readFileSync(join(cwd, '.env'), 'utf8'), /secret-do-not-touch/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('MemoryStore.init reports replica set true (no-op)', async () => {
  const r = await new MemoryStore().init();
  assert.equal(r.replicaSet, true);
});

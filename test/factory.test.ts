import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store/factory.ts';

test('unknown database rejects with a clear message', async () => {
  await assert.rejects(() => createStore('mysql', {}), /unsupported database "mysql"/);
});

test('mongodb requires MONGO_URI and MONGO_DB', async () => {
  await assert.rejects(() => createStore('mongodb', {}), /requires MONGO_URI and MONGO_DB/);
});

test('sqlite builds a store with prompt-content disabled', async () => {
  const store = await createStore('sqlite', { SQLITE_PATH: ':memory:' });
  try {
    assert.equal(store.capabilities.promptContents, false);
    assert.equal(store.capabilities.backup, false);
  } finally { await store.close(); }
});

test('sqlite file resolution: SQLITE_PATH, then config sqlite.file, then ./n8c.sqlite', async () => {
  const { mkdtempSync, rmSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'n8c-factory-'));
  const prevCwd = process.cwd();
  process.chdir(dir);
  try {
    const viaCfg = await createStore('sqlite', {}, { sqlite: { file: 'from-config.sqlite' } });
    await viaCfg.close();
    assert.ok(existsSync(join(dir, 'from-config.sqlite')), 'config sqlite.file used when SQLITE_PATH is unset');
    const viaVar = await createStore('sqlite', { SQLITE_PATH: 'from-var.sqlite' }, { sqlite: { file: 'from-config.sqlite' } });
    await viaVar.close();
    assert.ok(existsSync(join(dir, 'from-var.sqlite')), 'SQLITE_PATH wins over config');
    const dflt = await createStore('sqlite', {});
    await dflt.close();
    assert.ok(existsSync(join(dir, 'n8c.sqlite')), 'default file name');
  } finally {
    process.chdir(prevCwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

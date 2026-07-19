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

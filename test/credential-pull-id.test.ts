import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/store/memory.ts';
import { credential } from '../src/entities/credential.ts';
import { pullEntity } from '../src/engine/pull.ts';

function ctx(store: MemoryStore, creds: any[]) {
  return { env: 'staging', encrypted: false, n8n: { listCredentials: async () => creds }, getDefinitions: (k: string) => store.getDefinitions('staging', k) } as any;
}

test('credential pull assigns a UUID localId (not the n8n id) and maps it', async () => {
  const store = new MemoryStore();
  await pullEntity(store, credential, '/tmp', ctx(store, [{ id: 'UVlZPrugEfe4CZTZ', name: 'Mongo', type: 'mongoDb' }]));
  const docs = await store.getVersion('credentials', (await store.listVersions('credentials'))[0].versionId);
  assert.match(docs[0].localId, /[0-9a-f-]{36}/, 'localId is a UUID, not the n8n id');
  const defs: any = await store.getDefinitions('staging', 'credentials');
  assert.deepEqual(defs[docs[0].localId], { id: 'UVlZPrugEfe4CZTZ', name: 'Mongo' }, 'definition maps localId -> {id,name}');
});

test('re-pull reuses the localId via reverse-lookup', async () => {
  const store = new MemoryStore();
  const creds = [{ id: 'c1', name: 'OpenAI', type: 'openAiApi' }];
  await pullEntity(store, credential, '/tmp', ctx(store, creds));
  const lid = Object.keys(await store.getDefinitions('staging', 'credentials'))[0];
  await pullEntity(store, credential, '/tmp', ctx(store, creds));
  assert.deepEqual(Object.keys(await store.getDefinitions('staging', 'credentials')), [lid], 'same localId on re-pull');
});

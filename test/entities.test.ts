import { test } from 'node:test';
import assert from 'node:assert/strict';
import { credential } from '../src/entities/credential.ts';
import { workflow } from '../src/entities/workflow.ts';
import { isEncrypted } from '../src/crypto.ts';

const ctx = { env: 'test', encrypted: true, encryptionKey: 'k', getDefinitions: async () => ({}) } as any;

test('credential beforeSave encrypts data, beforePush decrypts it', async () => {
  const saved: any = credential.beforeSave!(ctx, { name: 'c', type: 'httpHeaderAuth', data: { token: 't' } });
  assert.ok(isEncrypted(saved.data));
  const pushed: any = await credential.beforePush!(ctx, saved, {});
  assert.deepEqual(pushed.data, { token: 't' });
});

test('credential beforeSave leaves data plain when encryption disabled', () => {
  const saved: any = credential.beforeSave!({ ...ctx, encrypted: false }, { name: 'c', type: 't', data: { token: 't' } });
  assert.deepEqual(saved.data, { token: 't' });
});

test('workflow beforePush remaps credential localId to {id,name}', async () => {
  const defs = { 'cred-local': { id: 'n8n-cred-9', name: 'Shopify' } };
  const body = { nodes: [{ name: 'n', credentials: { httpHeaderAuth: { id: 'cred-local' } } }] };
  const out: any = await workflow.beforePush!(ctx, body, defs);
  assert.deepEqual(out.nodes[0].credentials.httpHeaderAuth, { id: 'n8n-cred-9', name: 'Shopify' });
});

test('workflow beforePush throws on missing mapping', async () => {
  const body = { nodes: [{ name: 'n', credentials: { x: { id: 'unknown' } } }] };
  await assert.rejects(() => Promise.resolve(workflow.beforePush!(ctx, body, {})), /missing credential mapping for unknown/);
});

test('missingFieldsFromError: a marker with no (or only one) quote yields no field', async () => {
  const { missingFieldsFromError } = await import('../src/entities/credential.ts');
  assert.deepEqual(missingFieldsFromError('request.body.data requires property host'), []);
  assert.deepEqual(missingFieldsFromError('request.body.data requires property "host'), []);
  assert.deepEqual(missingFieldsFromError('requires property "a" and requires property "a"'), ['a'], 'deduped');
});

test('credentialFieldDefaults: an unreadable schema means no defaults (and is cached)', async () => {
  const { credentialFieldDefaults } = await import('../src/entities/credential.ts');
  let calls = 0;
  const c: any = { n8n: { getCredentialSchema: async () => { calls++; throw new Error('404'); } } };
  assert.deepEqual(await credentialFieldDefaults(c, 'fooApi'), {});
  assert.deepEqual(await credentialFieldDefaults(c, 'fooApi'), {});
  assert.equal(calls, 1);
});

test('fillMissingFields: nothing missing means nothing to complete', async () => {
  const { fillMissingFields } = await import('../src/entities/credential.ts');
  // direct call: callers only reach this with a non-empty list, so the empty case is a defensive guard
  assert.equal(await fillMissingFields({} as any, 'fooApi', { a: 1 }, []), null);
});

test('credential encryption helpers demand the key when it is missing', () => {
  const noKey = { env: 'test', encrypted: true, getDefinitions: async () => ({}) } as any;
  assert.throws(() => credential.beforeSave!(noKey, { name: 'c', type: 't', data: { a: 1 } }), /N8C_CREDENTIAL_ENCRYPTION_KEY required to encrypt/);
  const saved: any = credential.beforeSave!(ctx, { name: 'c', type: 't', data: { a: 1 } });
  assert.throws(() => credential.beforePush!(noKey, saved), /N8C_CREDENTIAL_ENCRYPTION_KEY required to decrypt/);
});

test('credential create with no data in the file sends an empty data object', async () => {
  const sent: any[] = [];
  const c: any = { env: 'test', encrypted: false, getDefinitions: async () => ({}),
    n8n: { createCredential: async (b: any) => { sent.push(b); return { id: 'NEW', updatedAt: 'T' }; } } };
  const mapping = await credential.pushToServer!(c, [{ localId: 'c1', name: 'Bare', body: { name: 'Bare', type: 'fooApi' }, checksum: 'x' }], { c1: 'new' });
  assert.deepEqual(sent, [{ name: 'Bare', type: 'fooApi', data: {} }]);
  assert.deepEqual(mapping, { c1: { id: 'NEW', name: 'Bare', updatedAt: 'T' } });
});

test('workflow.beforePush tolerates a body without nodes', async () => {
  const out: any = await workflow.beforePush!(ctx, { name: 'Shell' }, {});
  assert.equal(out.name, 'Shell');
  assert.deepEqual(out.connections, {});
});

test('workflow.pullFromServer carries description, nodeGroups, staticData and pinData into the body', async () => {
  const c: any = { getDefinitions: async () => ({}), n8n: { listWorkflows: async () => [{
    id: 'W1', name: 'Full', nodes: [], connections: {}, description: 'desc', nodeGroups: [{ g: 1 }], staticData: { s: 1 }, pinData: { p: 1 },
  }] } };
  const [row] = await workflow.pullFromServer!(c);
  assert.equal(row.body.description, 'desc');
  assert.deepEqual(row.body.nodeGroups, [{ g: 1 }]);
  assert.deepEqual(row.body.staticData, { s: 1 });
  assert.deepEqual(row.body.pinData, { p: 1 });
});

test('workflow.pushToServer: update PUT omits staticData, create POST keeps it', async () => {
  const updates: any[] = [];
  const creates: any[] = [];
  const c = {
    ...ctx,
    getDefinitions: async (k: string) => (k === 'workflows' ? { W1: 'N1' } : {}),
    n8n: {
      updateWorkflow: async (id: string, b: any) => { updates.push({ id, b }); },
      createWorkflow: async (b: any) => { creates.push(b); return { id: 'NEW' }; },
    },
  } as any;
  const body = { name: 'w', nodes: [], connections: {}, settings: {}, staticData: { cursor: 5 } };
  const docs = [
    { localId: 'W1', name: 'w', body, checksum: 'x' },
    { localId: 'W2', name: 'w2', body, checksum: 'y' },
  ];
  const mapping = await workflow.pushToServer!(c, docs, {});
  assert.deepEqual(mapping, { W1: 'N1', W2: 'NEW' });
  assert.equal(updates.length, 1);
  assert.ok(!('staticData' in updates[0].b), 'update must not rewind live trigger state');
  assert.deepEqual(creates[0].staticData, { cursor: 5 });
});

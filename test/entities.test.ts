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

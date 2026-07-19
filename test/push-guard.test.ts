import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../src/store/memory.ts';
import { credential } from '../src/entities/credential.ts';
import { workflow } from '../src/entities/workflow.ts';
import { writeEntity } from '../src/layout.ts';
import { applyEntity } from '../src/engine/apply.ts';

function fakeN8n() {
  const calls = { createCredential: 0, updateCredential: 0, createWorkflow: 0, updateWorkflow: 0 };
  return {
    calls,
    createCredential: async () => ({ id: 'CRED' + (++calls.createCredential), updatedAt: 'T0' }),
    updateCredential: async (id: string) => { calls.updateCredential++; return { id, updatedAt: 'T' + calls.updateCredential }; },
    createWorkflow: async () => ({ id: 'WF' + (++calls.createWorkflow) }),
    updateWorkflow: async () => { calls.updateWorkflow++; return {}; },
    listWorkflows: async () => [],
    listCredentials: async () => [],
  };
}
const ctx = (store: MemoryStore, n8n: any) => ({ env: 'test', encrypted: false, n8n, getDefinitions: (k: string) => store.getDefinitions('test', k) } as any);

test('#1 credential apply creates once, skips create on unchanged re-apply', async () => {
  const root = mkdtempSync(join(tmpdir(), 'n8c-'));
  try {
    const store = new MemoryStore(); const n8n = fakeN8n();
    writeEntity(root, 'credentials', 'c1', { name: 'Shopify' }, { name: 'Shopify', type: 'httpHeaderAuth', data: { token: 't' } });
    await applyEntity(store, credential, root, ctx(store, n8n), { dry: false });
    await applyEntity(store, credential, root, ctx(store, n8n), { dry: false });
    assert.equal(n8n.calls.createCredential, 1, 'no duplicate credential on unchanged re-apply');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('#1 a real credential change PATCHes in place (no duplicate on n8n)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'n8c-'));
  try {
    const store = new MemoryStore(); const n8n = fakeN8n();
    writeEntity(root, 'credentials', 'c1', { name: 'S' }, { name: 'S', type: 'httpHeaderAuth', data: { token: 't1' } });
    await applyEntity(store, credential, root, ctx(store, n8n), { dry: false });
    writeEntity(root, 'credentials', 'c1', { name: 'S' }, { name: 'S', type: 'httpHeaderAuth', data: { token: 't2' } });
    await applyEntity(store, credential, root, ctx(store, n8n), { dry: false });
    assert.equal(n8n.calls.createCredential, 1, 'created once');
    assert.equal(n8n.calls.updateCredential, 1, 'change → PATCH in place, not a second create');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('#2 --draft does not push a server-backed entity to n8n', async () => {
  const root = mkdtempSync(join(tmpdir(), 'n8c-'));
  try {
    const store = new MemoryStore(); const n8n = fakeN8n();
    writeEntity(root, 'credentials', 'c1', { name: 'S' }, { name: 'S', type: 'httpHeaderAuth', data: { token: 't' } });
    const r = await applyEntity(store, credential, root, ctx(store, n8n), { dry: false, draft: true });
    assert.equal(n8n.calls.createCredential, 0, 'draft must not touch n8n');
    assert.equal(r.draft, true);
    assert.equal((await store.getLive('credentials')).length, 0, 'draft does not write live');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('#3 workflow pushToServer creates a new workflow when there is no mapping', async () => {
  const store = new MemoryStore(); const n8n = fakeN8n();
  const docs = [{ localId: 'w1', name: 'W', body: { name: 'W', nodes: [], connections: {} } }];
  const map = await workflow.pushToServer!(ctx(store, n8n), docs as any, { w1: 'new' });
  assert.equal(n8n.calls.createWorkflow, 1);
  assert.equal(map['w1'], 'WF1');
});

test('#3 workflow pushToServer PUTs the changed one, skips the identical one', async () => {
  const store = new MemoryStore(); const n8n = fakeN8n();
  await store.withTransaction((s) => store.putDefinitions('test', 'workflows', { w1: 'EXIST1', w2: 'EXIST2' }, s));
  const docs = [
    { localId: 'w1', name: 'W1', body: { name: 'W1', nodes: [], connections: {} } },
    { localId: 'w2', name: 'W2', body: { name: 'W2', nodes: [], connections: {} } },
  ];
  const map = await workflow.pushToServer!(ctx(store, n8n), docs as any, { w1: 'changed', w2: 'identical' });
  assert.equal(n8n.calls.updateWorkflow, 1, 'only the changed workflow is PUT');
  assert.equal(n8n.calls.createWorkflow, 0);
  assert.deepEqual(map, { w1: 'EXIST1', w2: 'EXIST2' }, 'full mapping returned (replace-safe)');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/store/memory.ts';
import { workflow } from '../src/entities/workflow.ts';
import { pullEntity } from '../src/engine/pull.ts';

function ctxWith(store: MemoryStore, workflows: any[]) {
  return {
    env: 'staging', encrypted: false,
    n8n: { listWorkflows: async () => workflows },
    getDefinitions: (k: string) => store.getDefinitions('staging', k),
  } as any;
}

test('pull mints a UUID localId for an unmarked (UI-made) workflow and records the mapping', async () => {
  const store = new MemoryStore();
  await pullEntity(store, workflow, '/tmp', ctxWith(store, [{ id: '0MutHWGJpa5zi9ms', name: 'Main', nodes: [], connections: {} }]));
  const docs = await store.getVersion('workflows', (await store.listVersions('workflows'))[0].versionId);
  assert.match(docs[0].localId, /[0-9a-f-]{36}/, 'localId is our UUID, not the n8n id');
  assert.equal((docs[0].body as any).meta.n8cLocalId, docs[0].localId, 'marker embedded in body meta');
  const defs = await store.getDefinitions('staging', 'workflows');
  assert.equal(defs[docs[0].localId], '0MutHWGJpa5zi9ms', 'definition maps localId -> n8n id');
});

test('pull reuses the localId from the meta marker (stable across envs)', async () => {
  const store = new MemoryStore();
  const r = await pullEntity(store, workflow, '/tmp',
    ctxWith(store, [{ id: 'prod-id-123', name: 'Main', nodes: [], connections: {}, meta: { n8cLocalId: 'fixed-uuid' } }]));
  const defs = await store.getDefinitions('staging', 'workflows');
  assert.equal(defs['fixed-uuid'], 'prod-id-123');
  assert.equal(r.deduped, false);
});

test('re-pull reuses the localId via reverse-lookup and dedups', async () => {
  const store = new MemoryStore();
  const wf = { id: 'abc', name: 'Main', nodes: [], connections: {} };
  const r1 = await pullEntity(store, workflow, '/tmp', ctxWith(store, [wf]));
  const lid = Object.keys(await store.getDefinitions('staging', 'workflows'))[0];
  // second pull of the SAME workflow (now mapping exists) -> same localId, dedup
  const r2 = await pullEntity(store, workflow, '/tmp', ctxWith(store, [wf]));
  assert.equal(r2.deduped, true, 'unchanged re-pull dedups');
  assert.deepEqual(Object.keys(await store.getDefinitions('staging', 'workflows')), [lid]);
});

test('push sends ONLY writable fields — no read-only meta/id/active (n8n rejects them)', async () => {
  const pushed: any[] = [];
  const store = new MemoryStore();
  await store.withTransaction((s) => store.putDefinitions('staging', 'workflows', { 'my-uuid': 'n8n-9' }, s));
  const ctx = { env: 'staging', encrypted: false, n8n: { updateWorkflow: async (id: string, b: any) => { pushed.push({ id, b }); } },
    getDefinitions: (k: string) => store.getDefinitions('staging', k) } as any;
  await workflow.pushToServer!(ctx, [{ localId: 'my-uuid', name: 'Main', body: { id: 'stale', active: true, meta: { n8cLocalId: 'my-uuid' }, tags: ['x'], name: 'Main', nodes: [], connections: {}, settings: { a: 1 } } }], { 'my-uuid': 'changed' });
  assert.equal(pushed[0].id, 'n8n-9');
  const keys = Object.keys(pushed[0].b).sort();
  assert.deepEqual(keys, ['connections', 'name', 'nodes', 'settings'], 'only writable fields sent');
  for (const bad of ['id', 'active', 'meta', 'tags']) assert.ok(!(bad in pushed[0].b), `${bad} must not be sent`);
});

test('push whitelists settings keys — drops n8n UI-only extras (400 additional properties)', async () => {
  const pushed: any[] = [];
  const store = new MemoryStore();
  await store.withTransaction((s) => store.putDefinitions('staging', 'workflows', { 'w': 'n8n-1' }, s));
  const ctx = { env: 'staging', encrypted: false, n8n: { updateWorkflow: async (id: string, b: any) => { pushed.push(b); } },
    getDefinitions: (k: string) => store.getDefinitions('staging', k) } as any;
  const settings = { executionOrder: 'v1', errorWorkflow: 'EW1', callerPolicy: 'workflowsFromSameOwner', availableInMCP: true, binaryMode: 'separate', timeSavedMode: 'fixed' };
  await workflow.pushToServer!(ctx, [{ localId: 'w', name: 'W', body: { name: 'W', nodes: [], connections: {}, settings } }], { w: 'changed' });
  assert.deepEqual(Object.keys(pushed[0].settings).sort(), ['availableInMCP', 'callerPolicy', 'errorWorkflow', 'executionOrder'], 'kept API-accepted keys (incl. availableInMCP)');
  for (const bad of ['binaryMode', 'timeSavedMode']) assert.ok(!(bad in pushed[0].settings), `${bad} (not in schema) dropped`);
});

test('push strips node keys to the API-accepted set (drops createdAt/updatedAt/UI-only)', async () => {
  const pushed: any[] = [];
  const store = new MemoryStore();
  await store.withTransaction((s) => store.putDefinitions('staging', 'workflows', { w: 'n8n-1' }, s));
  const ctx = { env: 'staging', encrypted: false, n8n: { updateWorkflow: async (_id: string, b: any) => { pushed.push(b); } },
    getDefinitions: (k: string) => store.getDefinitions('staging', k) } as any;
  const node = { id: 'n1', name: 'A', type: 'x', typeVersion: 1, position: [0, 0], parameters: { a: 1 }, createdAt: 'T', updatedAt: 'T', uiOnlyField: true };
  await workflow.pushToServer!(ctx, [{ localId: 'w', name: 'W', body: { name: 'W', nodes: [node], connections: {} } }], { w: 'changed' });
  const keys = Object.keys(pushed[0].nodes[0]);
  for (const bad of ['createdAt', 'updatedAt', 'uiOnlyField']) assert.ok(!keys.includes(bad), `${bad} stripped`);
  for (const good of ['id', 'name', 'type', 'parameters', 'position']) assert.ok(keys.includes(good), `${good} kept`);
});

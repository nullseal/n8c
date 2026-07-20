import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../src/store/memory.ts';
import { mapCredentialsFromWorkflows } from '../src/engine/environment.ts';
import { materializeWorkflowSource } from '../src/engine/materialize.ts';
import { workflow as workflowDesc } from '../src/entities/workflow.ts';
import { credential as credentialDesc } from '../src/entities/credential.ts';
import { pullEntity } from '../src/engine/pull.ts';

test('a node-referenced credential the API cannot list survives the credential pull', async () => {
  // Regression: the credential pull writes the mapping with replace-semantics from
  // listCredentials. A credential in another n8n project isn't listed, so pulling
  // credentials AFTER mapping-from-nodes wiped it and workflow export then failed
  // with "has no localId mapping — run `n8c pull` first" *during a pull*.
  const store = new MemoryStore();
  const listed = [{ id: 'VISIBLE', name: 'Mongo', type: 'mongoDb' }];
  const wfs = [{ id: 'w1', name: 'Main', nodes: [
    { id: 'n1', name: 'A', credentials: { mongoDb: { id: 'VISIBLE', name: 'Mongo' } } },
    { id: 'n2', name: 'B', credentials: { openAiApi: { id: 'OTHER_PROJECT', name: 'OpenAI account' } } },
  ] }];
  const ctx = { env: 'staging', encrypted: false,
    n8n: { listWorkflows: async () => wfs, listCredentials: async () => listed },
    getDefinitions: (k: string) => store.getDefinitions('staging', k) } as any;

  // pull order: credentials first (replace), then map-from-nodes (merge on top)
  await pullEntity(store, credentialDesc, '/tmp', ctx);
  await mapCredentialsFromWorkflows(store, ctx);

  const defs: any = await store.getDefinitions('staging', 'credentials');
  const ids = Object.values(defs).map((v: any) => v.id).sort();
  assert.deepEqual(ids, ['OTHER_PROJECT', 'VISIBLE'], 'the unlistable credential is still mapped');
});

test('workflow export throws when a node credential has no localId mapping (no raw-id fallback)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'n8c-'));
  try {
    const store = new MemoryStore();
    const body = { name: 'f', nodes: [{ id: 'n1', name: 'A', type: 'x', parameters: {}, credentials: { mongoDb: { id: 'UNMAPPED_ID', name: 'Mongo' } } }], connections: {} };
    await store.withTransaction((s) => store.createSnapshot('workflows', 'v1', [{ localId: 'w1', name: 'f', body, checksum: 'c' }], 'b', s));
    const ctx = { env: 'prod', encrypted: false, getDefinitions: (k: string) => store.getDefinitions('prod', k) } as any;
    const { exportVersion } = await import('../src/engine/transfer.ts');
    await assert.rejects(() => exportVersion(store, workflowDesc, root, 'v1', ctx), /no localId mapping/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('workflow export is idempotent: a ref already a localId is kept (no throw on re-export)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'n8c-'));
  try {
    const store = new MemoryStore();
    // the stored workflow already references the credential by its localId (from a
    // prior export→apply round-trip), not the n8n id.
    const body = { name: 'f', nodes: [{ id: 'n1', name: 'A', type: 'x', parameters: {}, credentials: { openAiApi: { id: 'be2a60f8-uuid', name: 'OpenAI account' } } }], connections: {} };
    await store.withTransaction((s) => store.createSnapshot('workflows', 'v1', [{ localId: 'w1', name: 'f', body, checksum: 'c' }], 'b', s));
    await store.withTransaction((s) => store.putDefinitions('prod', 'credentials', { 'be2a60f8-uuid': { id: 'N8N_OPENAI', name: 'OpenAI account' } }, s));
    const ctx = { env: 'prod', encrypted: false, getDefinitions: (k: string) => store.getDefinitions('prod', k) } as any;
    const { exportVersion } = await import('../src/engine/transfer.ts');
    await exportVersion(store, workflowDesc, root, 'v1', ctx); // must NOT throw
    const envJson = JSON.parse(readFileSync(join(root, 'workflows', 'w1', 'environment.json'), 'utf8'));
    assert.deepEqual(envJson, { credentials: { 'be2a60f8-uuid': { name: 'OpenAI account' } } }, 'localId kept');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('mapCredentialsFromWorkflows maps every credential a workflow uses (UUID, reused)', async () => {
  const store = new MemoryStore();
  const wfs = [{ id: 'w1', name: 'W', nodes: [
    { id: 'n1', name: 'A', credentials: { openAiApi: { id: 'gpNzYPjMBrcX6utK', name: 'OpenAI IZIHelp Staging' } } },
    { id: 'n2', name: 'B', credentials: { openAiApi: { id: 'gpNzYPjMBrcX6utK', name: 'OpenAI IZIHelp Staging' } } },
  ] }];
  const ctx = { env: 'staging', encrypted: false, n8n: { listWorkflows: async () => wfs }, getDefinitions: (k: string) => store.getDefinitions('staging', k) } as any;

  const r1 = await mapCredentialsFromWorkflows(store, ctx);
  assert.equal(r1.mapped, 1, 'one unique credential mapped');
  const defs: any = await store.getDefinitions('staging', 'credentials');
  const localId = Object.keys(defs)[0];
  assert.match(localId, /[0-9a-f-]{36}/, 'localId is a UUID');
  assert.deepEqual(defs[localId], { id: 'gpNzYPjMBrcX6utK', name: 'OpenAI IZIHelp Staging' });

  // re-run: same localId reused
  await mapCredentialsFromWorkflows(store, ctx);
  assert.deepEqual(Object.keys(await store.getDefinitions('staging', 'credentials')), [localId]);
});

test('workflow export writes environment.json with used credentials by localId', async () => {
  const root = mkdtempSync(join(tmpdir(), 'n8c-'));
  try {
    const store = new MemoryStore();
    const body = { name: 'f', nodes: [{ id: 'n1', name: 'A', type: 'x', parameters: {}, credentials: { mongoDb: { id: 'PROD_ID_123', name: 'Mongo' } } }], connections: {} };
    await store.withTransaction((s) => store.createSnapshot('workflows', 'v1', [{ localId: 'w1', name: 'f', body, checksum: 'c' }], 'b', s));
    await store.withTransaction((s) => store.putDefinitions('prod', 'credentials', { 'my-uuid': { id: 'PROD_ID_123', name: 'Mongo' } }, s));
    const ctx = { env: 'prod', encrypted: false, getDefinitions: (k: string) => store.getDefinitions('prod', k) } as any;

    const { exportVersion } = await import('../src/engine/transfer.ts');
    await exportVersion(store, workflowDesc, root, 'v1', ctx);
    const envJson = JSON.parse(readFileSync(join(root, 'workflows', 'w1', 'environment.json'), 'utf8'));
    assert.deepEqual(envJson, { credentials: { 'my-uuid': { name: 'Mongo' } } });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('workflow export relinks node credential ids n8n → localId', () => {
  const body = { name: 'f', nodes: [{ id: 'n1', name: 'A', type: 'x', parameters: {}, credentials: { mongoDb: { id: 'PROD_ID_123', name: 'Mongo' } } }], connections: {} };
  const src = materializeWorkflowSource(body, { 'PROD_ID_123': 'my-uuid' });
  assert.match(src, /"id": "my-uuid"/, 'credential id rewritten to localId');
  assert.doesNotMatch(src, /PROD_ID_123/, 'n8n id removed');
});

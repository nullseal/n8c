import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../src/store/memory.ts';
import { credential } from '../src/entities/credential.ts';
import { workflow } from '../src/entities/workflow.ts';
import { writeEntity } from '../src/layout.ts';
import { applyEntity } from '../src/engine/apply.ts';

test('credential apply then workflow apply attaches resolved credential', async () => {
  const root = mkdtempSync(join(tmpdir(), 'n8c-'));
  try {
    const store = new MemoryStore();
    const pushed: any[] = [];
    const fakeN8n = {
      createCredential: async (b: any) => { pushed.push(b); return { id: 'n8n-cred-1' }; },
      updateWorkflow: async (id: string, b: any) => { pushed.push({ id, b }); return b; },
      listWorkflows: async () => [], listCredentials: async () => [],
    };
    const base = { encrypted: true, encryptionKey: 'k', env: 'test', n8n: fakeN8n,
      getDefinitions: (k: string) => store.getDefinitions('test', k) };

    // credential with a fixed localId
    writeEntity(root, 'credentials', 'cred-local', { name: 'Shopify' }, { name: 'Shopify', type: 'httpHeaderAuth', data: { token: 't' } });
    await applyEntity(store, credential, root, base as any, { dry: false });
    assert.ok((await store.getDefinitions('test', 'credentials'))['cred-local']);

    // set workflow n8n mapping so push can PUT
    await store.withTransaction((s) => store.putDefinitions('test', 'workflows', { 'wf-local': 'n8n-wf-1' }, s));

    // workflow whose node references the credential localId
    const wf = join(root, 'workflows', 'wf-local');
    mkdirSync(wf, { recursive: true });
    writeFileSync(join(wf, 'metadata.json'), JSON.stringify({ name: 'flow' }));
    writeFileSync(join(wf, 'apply.ts'), 'export default { name: "flow", nodes: [{ name: "http", credentials: { httpHeaderAuth: { id: "cred-local" } } }], connections: {} };\n');
    await applyEntity(store, workflow, root, base as any, { dry: false });

    const put = pushed.find((p) => p.id === 'n8n-wf-1');
    assert.ok(put, 'workflow was PUT');
    assert.deepEqual(put.b.nodes[0].credentials.httpHeaderAuth, { id: 'n8n-cred-1', name: 'Shopify' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

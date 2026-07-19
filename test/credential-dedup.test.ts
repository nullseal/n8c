import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../src/store/memory.ts';
import { credential } from '../src/entities/credential.ts';
import { writeEntity } from '../src/layout.ts';
import { applyEntity } from '../src/engine/apply.ts';

// Regression: credential.beforeSave encrypts with a random salt/IV each call.
// Identity (checksum) must be taken over the PLAINTEXT body, otherwise every
// re-apply looks "changed" and dedup never fires. No n8n client here, so
// pushToServer is skipped (hasServer is true but ctx.n8n is undefined).
function ctx() {
  return { env: 'test', encrypted: true, encryptionKey: 'k', getDefinitions: async () => ({}) } as any;
}

test('credential re-apply with unchanged secret is identical and dedups', async () => {
  const root = mkdtempSync(join(tmpdir(), 'n8c-'));
  try {
    const store = new MemoryStore();
    writeEntity(root, 'credentials', 'c1', { name: 'Shopify' }, { name: 'Shopify', type: 'httpHeaderAuth', data: { token: 't' } });

    const r1 = await applyEntity(store, credential, root, ctx(), { dry: false });
    assert.equal(r1.plan[0].status, 'new');
    assert.equal((await store.listVersions('credentials')).length, 1);

    const r2 = await applyEntity(store, credential, root, ctx(), { dry: false });
    assert.equal(r2.plan[0].status, 'identical', 'unchanged secret must read as identical');
    assert.equal((await store.listVersions('credentials')).length, 1, 'no new snapshot when unchanged');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('credential apply detects a real secret change', async () => {
  const root = mkdtempSync(join(tmpdir(), 'n8c-'));
  try {
    const store = new MemoryStore();
    writeEntity(root, 'credentials', 'c1', { name: 'Shopify' }, { name: 'Shopify', type: 'httpHeaderAuth', data: { token: 't1' } });
    await applyEntity(store, credential, root, ctx(), { dry: false });
    writeEntity(root, 'credentials', 'c1', { name: 'Shopify' }, { name: 'Shopify', type: 'httpHeaderAuth', data: { token: 't2' } });
    const r = await applyEntity(store, credential, root, ctx(), { dry: false });
    assert.equal(r.plan[0].status, 'changed');
    assert.equal((await store.listVersions('credentials')).length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

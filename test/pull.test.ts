import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../src/store/memory.ts';
import { prompt } from '../src/entities/prompt.ts';
import { pullEntity, commitPullGeneration } from '../src/engine/pull.ts';
import { exportDocs } from '../src/engine/transfer.ts';
import { checksum } from '../src/checksum.ts';

function ctx() { return { env: 'test', encrypted: false, getDefinitions: async () => ({}) } as any; }

async function setLive(store: MemoryStore, body: unknown) {
  await store.withTransaction((s) =>
    store.putLive('prompts', [{ localId: 'p1', name: 'g', body, checksum: checksum(body) }], s));
}

test('pullEntity fetches docs + checksum and writes NO version (generation is committed separately)', async () => {
  const store = new MemoryStore();
  await setLive(store, { v: 'A' });
  const r = await pullEntity(store, prompt, '/tmp', ctx());
  assert.equal(r.kind, 'prompts');
  assert.equal(r.docs.length, 1, 'docs returned so the CLI can export straight from them');
  assert.equal(r.checksum, checksum(r.docs.map((d) => d.checksum).sort()));
  assert.equal((await store.listVersions('prompts')).length, 0, 'pull itself creates no version');
  assert.deepEqual((await store.getLive('prompts'))[0].body, { v: 'A' }, 'live untouched');
});

test('pull sets the live baseline for EVERY kind, so later generations are complete', async () => {
  // Regression (two `*` in `n8c list`): apply snapshots a generation from the LIVE
  // docs and skips kinds that have none. Workflow live was only written by an apply
  // that actually pushed a workflow, so an apply with no workflow changes produced a
  // generation MISSING workflows — leaving their active pointer on an older
  // generation, and making `restore <generation>` silently skip workflows.
  const { workflow } = await import('../src/entities/workflow.ts');
  const store = new MemoryStore();
  const ctx = {
    env: 'default', encrypted: false,
    n8n: { listWorkflows: async () => [{ id: 'W1', name: 'Main', nodes: [], connections: {} }] },
    getDefinitions: (k: string) => store.getDefinitions('default', k),
  } as any;
  const r = await pullEntity(store, workflow, '/tmp', ctx);
  const live = await store.getLive('workflows');
  assert.equal(live.length, 1, 'workflows have a live baseline after pull');
  assert.deepEqual(live.map((d) => d.checksum), r.docs.map((d) => d.checksum));
});

test('an unchanged re-pull yields the same bundle checksum', async () => {
  const store = new MemoryStore();
  await setLive(store, { v: 'A' });
  const first = await pullEntity(store, prompt, '/tmp', ctx());
  const second = await pullEntity(store, prompt, '/tmp', ctx());
  assert.equal(second.checksum, first.checksum);
  assert.deepEqual(second.docs, first.docs);
});

test('commitPullGeneration writes ONE generation across every kind and marks it active', async () => {
  const store = new MemoryStore();
  const gen = '2026-07-20T12:00:00.000Z';
  const results = [
    { kind: 'workflows', count: 1, checksum: 'cw', docs: [{ localId: 'w1', name: 'W', body: {}, checksum: 'w' }] },
    { kind: 'prompts', count: 1, checksum: 'cp', docs: [{ localId: 'p1', name: 'P', body: {}, checksum: 'p' }] },
    { kind: 'credentials', count: 0, checksum: 'cc', docs: [] }, // empty kind → skipped
  ];
  await commitPullGeneration(store, gen, results, 'pulled from staging');

  for (const kind of ['workflows', 'prompts']) {
    const versions = await store.listVersions(kind);
    assert.equal(versions.length, 1, `${kind} has one version`);
    assert.equal(versions[0].versionId, gen, `${kind} shares the SAME generation id`);
    assert.equal(versions[0].isActive, true, `${kind} generation is active`);
    assert.equal(versions[0].message, 'pulled from staging');
    assert.equal((await store.getVersion(kind, gen)).length, 1, `${kind} version docs stored`);
  }
  assert.equal((await store.listVersions('credentials')).length, 0, 'empty kind snapshots nothing');
});

test('exportDocs renders straight from docs, no store lookup', async () => {
  const root = mkdtempSync(join(tmpdir(), 'n8c-'));
  try {
    const docs = [{ localId: 'p1', name: 'main', body: { key: 'main', content: 'hi' }, checksum: 'c1' }];
    const warns = await exportDocs(prompt, root, docs);
    assert.deepEqual(warns, []);
    const applyTs = readFileSync(join(root, 'prompts', 'p1', 'apply.ts'), 'utf8');
    assert.match(applyTs, /"key": "main"/);
    assert.ok(existsSync(join(root, 'prompts', 'p1', 'metadata.json')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

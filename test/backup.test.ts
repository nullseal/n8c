import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dumpBackup, restoreBackup, type BackupDb, type BackupFile } from '../src/engine/backup.ts';
import { MemoryStore } from '../src/store/memory.ts';

// In-memory BackupDb: a Map<name, {docs, indexes}>.
function fakeDb(initial: Record<string, { docs: any[]; indexes: any[] }> = {}): BackupDb & { cols: Map<string, any> } {
  const cols = new Map(Object.entries(initial).map(([k, v]) => [k, { docs: [...v.docs], indexes: [...v.indexes] }]));
  return {
    cols,
    names: () => [...cols.keys()],
    find: async (n) => (cols.get(n)?.docs ?? []).slice(),
    listIndexes: async (n) => (cols.get(n)?.indexes ?? []).slice(),
    recreate: async (n) => { cols.set(n, { docs: [], indexes: [] }); },
    insert: async (n, docs) => { const c = cols.get(n) ?? { docs: [], indexes: [] }; c.docs.push(...docs); cols.set(n, c); },
    createIndex: async (n, idx) => { const c = cols.get(n) ?? { docs: [], indexes: [] }; c.indexes.push(idx); cols.set(n, c); },
  };
}

test('dumpBackup captures every collection\'s records and indexes', async () => {
  const db = fakeDb({
    n8c_workflows: { docs: [{ _id: 1, localId: 'w', mode: 'live' }], indexes: [{ name: 'live', key: { localId: 1 } }] },
    n8c_prompt_contents: { docs: [{ _id: 2, key: 'main_triage', content: 'x', mode: 'live' }], indexes: [] },
  });
  const file = await dumpBackup(db, '0.1.0', 'ai-mykingdom');
  assert.equal(file.format, 'n8c-backup/1');
  assert.equal(file.db, 'ai-mykingdom');
  assert.deepEqual(file.collections.n8c_workflows.docs, [{ _id: 1, localId: 'w', mode: 'live' }]);
  assert.equal(file.collections.n8c_workflows.indexes[0].name, 'live');
  assert.equal(file.collections.n8c_prompt_contents.docs.length, 1);
});

test('restoreBackup recreates collections, re-inserts docs and re-creates indexes', async () => {
  const src = fakeDb({
    n8c_workflows: { docs: [{ _id: 1, localId: 'w' }], indexes: [{ name: 'live', key: { localId: 1 }, options: { unique: false } }] },
    n8c_manifests: { docs: [{ _id: 9, role: 'version' }], indexes: [] },
  });
  const file = await dumpBackup(src, '0.1.0');
  const dst = fakeDb();                       // empty target
  const r = await restoreBackup(dst, file);
  assert.equal(r.collections, 2);
  assert.equal(r.docs, 2);
  assert.equal(r.indexes, 1);
  assert.deepEqual(dst.cols.get('n8c_workflows').docs, [{ _id: 1, localId: 'w' }]);
  assert.equal(dst.cols.get('n8c_workflows').indexes[0].name, 'live');
});

test('restoreBackup drops existing docs first (recreate)', async () => {
  const dst = fakeDb({ n8c_workflows: { docs: [{ _id: 'stale' }], indexes: [] } });
  const file: BackupFile = { format: 'n8c-backup/1', n8cVersion: '0', createdAt: '', collections: { n8c_workflows: { docs: [{ _id: 'fresh' }], indexes: [] } } };
  await restoreBackup(dst, file);
  assert.deepEqual(dst.cols.get('n8c_workflows').docs, [{ _id: 'fresh' }], 'stale doc replaced');
});

test('restoreBackup rejects a non-n8c file', async () => {
  await assert.rejects(() => restoreBackup(fakeDb(), { foo: 'bar' } as any), /not an n8c backup/);
});

test('MemoryStore has no backup port (mongodb only)', () => {
  assert.throws(() => new MemoryStore().backupDb(), /only supported for the mongodb store/);
});

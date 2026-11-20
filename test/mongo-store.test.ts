import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MongoStore } from '../src/store/mongo.ts';
import { resolveCollections } from '../src/store/collections.ts';

// ---- Minimal in-memory fake of the slice of the MongoDB driver MongoStore uses.
// Filters are shallow equality on plain fields (all MongoStore ever queries with);
// projections are `{f: 0}` (exclude) or `{f: 1}` (include) as MongoStore uses them.
function matches(doc: any, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([k, v]) => doc[k] === v);
}
function project(doc: any, proj?: Record<string, 0 | 1>): any {
  if (!proj) return { ...doc };
  const keys = Object.keys(proj);
  if (keys.every((k) => proj[k] === 0)) {
    const out = { ...doc };
    for (const k of keys) delete out[k];
    return out;
  }
  const out: any = {};
  for (const k of keys) if (k in doc) out[k] = doc[k];
  return out;
}

class FakeCollection {
  docs: any[] = [];
  created: { key: unknown; options: unknown }[] = [];
  indexList: any[] | Error = [{ name: '_id_', key: { _id: 1 } }];
  dropError?: Error;
  dropped = false;
  find(filter: Record<string, unknown> = {}, opts?: { projection?: Record<string, 0 | 1> }) {
    let rows = this.docs.filter((d) => matches(d, filter)).map((d) => project(d, opts?.projection));
    const cursor = {
      sort: (spec: Record<string, 1 | -1>) => {
        const [[k, dir]] = Object.entries(spec);
        rows = [...rows].sort((a, b) => (a[k] < b[k] ? -dir : a[k] > b[k] ? dir : 0));
        return cursor;
      },
      toArray: async () => rows,
    };
    return cursor;
  }
  async findOne(filter: Record<string, unknown>, opts?: { projection?: Record<string, 0 | 1> }) {
    const d = this.docs.find((x) => matches(x, filter));
    return d ? project(d, opts?.projection) : null;
  }
  async insertOne(doc: any) { this.docs.push({ ...doc }); }
  async insertMany(docs: any[]) { for (const d of docs) this.docs.push({ ...d }); }
  async updateOne(filter: Record<string, unknown>, update: { $set: any }, opts?: { upsert?: boolean }) {
    const d = this.docs.find((x) => matches(x, filter));
    if (d) Object.assign(d, update.$set);
    else if (opts?.upsert) this.docs.push({ ...filter, ...update.$set });
  }
  async updateMany(filter: Record<string, unknown>, update: { $set: any }) {
    for (const d of this.docs.filter((x) => matches(x, filter))) Object.assign(d, update.$set);
  }
  async deleteOne(filter: Record<string, unknown>) {
    const i = this.docs.findIndex((x) => matches(x, filter));
    if (i >= 0) this.docs.splice(i, 1);
  }
  async deleteMany(filter: Record<string, unknown>) { this.docs = this.docs.filter((x) => !matches(x, filter)); }
  async createIndex(key: unknown, options: unknown) { this.created.push({ key, options }); }
  async indexes() { if (this.indexList instanceof Error) throw this.indexList; return this.indexList; }
  async drop() { if (this.dropError) throw this.dropError; this.dropped = true; this.docs = []; }
}

class FakeClient {
  cols = new Map<string, FakeCollection>();
  connected = false;
  closed = false;
  endSessionCalls = 0;
  hello: any = { setName: 'rs0' };
  sessionId: any = { toString: () => 'sess-1' };
  col(name: string) { if (!this.cols.has(name)) this.cols.set(name, new FakeCollection()); return this.cols.get(name)!; }
  async connect() { this.connected = true; }
  async close() { this.closed = true; }
  db(_name: string) {
    return {
      collection: (n: string) => this.col(n),
      admin: () => ({ command: async () => { if (this.hello instanceof Error) throw this.hello; return this.hello; } }),
    };
  }
  startSession() {
    const self = this;
    return {
      get id() { return self.sessionId; },
      withTransaction: async (fn: () => Promise<void>) => { await fn(); },
      endSession: async () => { self.endSessionCalls++; },
    };
  }
}

const cols = resolveCollections();
function make() {
  const client = new FakeClient();
  const store = new MongoStore('mongodb://unused', 'db', cols, client as any);
  return { client, store };
}
const tx = <T>(s: MongoStore, fn: (session: any) => Promise<T>) => s.withTransaction(fn);

test('capabilities and connect/close go through the injected client', async () => {
  const { client, store } = make();
  assert.deepEqual(store.capabilities, { promptContents: true, backup: true });
  assert.equal(await store.connect(), store);
  assert.equal(client.connected, true);
  await store.close();
  assert.equal(client.closed, true);
});

test('constructor falls back to a real MongoClient and default collections when none is injected', async () => {
  const store = new MongoStore('mongodb://127.0.0.1:1', 'db');
  assert.equal(store.backupDb().names().length, 6);
  await store.close(); // never connected; close is a harmless no-op
});

test('putLive/getLive round-trip; putLive replaces the live set', async () => {
  const { store } = make();
  const docs = [{ localId: 'a', name: 'A', body: { x: 1 }, checksum: 'c1' }];
  await tx(store, (s) => store.putLive('workflows', docs, s));
  assert.deepEqual(await store.getLive('workflows'), docs);
  await tx(store, (s) => store.putLive('workflows', [], s));
  assert.deepEqual(await store.getLive('workflows'), []);
});

test('getLive ignores version rows (no mode:live)', async () => {
  const { client, store } = make();
  client.col(cols.workflows).docs.push({ versionId: 'v1', localId: 'z', name: 'Z', body: {}, checksum: 'c' });
  assert.deepEqual(await store.getLive('workflows'), []);
});

test('getLive(promptContents) rebuilds a body from a flat externally-seeded doc', async () => {
  const { client, store } = make();
  client.col(cols.promptContents).docs.push(
    { key: 'greet', content: 'hello', blocks: ['b'], mode: 'live' },
    { key: 'bare', mode: 'live' },
  );
  const live = await store.getLive('promptContents');
  assert.equal(live.length, 2);
  assert.equal(live[0].localId, 'greet');
  assert.equal(live[0].name, 'greet');
  assert.deepEqual(live[0].body, { key: 'greet', content: 'hello', blocks: ['b'] });
  assert.equal(typeof live[0].checksum, 'string');
  assert.ok(live[0].checksum.length > 0);
  // no content/blocks -> only the key is carried
  assert.deepEqual(live[1].body, { key: 'bare' });
});

test('getLive(promptContents) keeps the nested body of an n8c-written doc and its stored checksum', async () => {
  const { store } = make();
  const body = { key: 'k', content: 'c' };
  await tx(store, (s) => store.putLive('promptContents', [{ localId: 'k', name: 'K', body, checksum: 'stored' }], s));
  assert.deepEqual(await store.getLive('promptContents'), [{ localId: 'k', name: 'K', body, checksum: 'stored' }]);
});

test('upsertLive inserts then updates in place', async () => {
  const { store } = make();
  await tx(store, (s) => store.upsertLive('prompts', [{ localId: 'p1', name: 'P', body: { v: 1 }, checksum: 'c1' }], s));
  await tx(store, (s) => store.upsertLive('prompts', [{ localId: 'p1', name: 'P', body: { v: 2 }, checksum: 'c2' }], s));
  const live = await store.getLive('prompts');
  assert.equal(live.length, 1);
  assert.deepEqual(live[0], { localId: 'p1', name: 'P', body: { v: 2 }, checksum: 'c2' });
});

test('createSnapshot + listVersions (sorted, docs projected out) + getVersion from per-kind rows', async () => {
  const { client, store } = make();
  const docs = [{ localId: 'a', name: 'A', body: { k: 1 }, checksum: 'c1' }];
  await tx(store, (s) => store.createSnapshot('workflows', 'v2', docs, 'bundle2', s));
  await tx(store, (s) => store.createSnapshot('workflows', 'v1', docs, 'bundle1', s, 'first', true));
  await tx(store, (s) => store.createSnapshot('workflows', 'v0', [], 'empty', s)); // no docs -> no per-kind insert
  const versions = await store.listVersions('workflows');
  assert.deepEqual(versions.map((v) => v.versionId), ['v0', 'v1', 'v2']);
  assert.equal(versions[1].message, 'first');
  assert.equal(versions[1].draft, true);
  assert.equal(versions[1].isActive, false);
  assert.deepEqual(await store.getVersion('workflows', 'v1'), docs);
  assert.deepEqual(await store.getVersion('workflows', 'v0'), []);
  // a legacy embedded `docs` array is never returned by the listing
  client.col(cols.manifests).docs.push({ kind: 'workflows', versionId: 'v9', docs: [{ localId: 'x' }] });
  const listed: any[] = await store.listVersions('workflows');
  assert.ok(listed.every((v) => !('docs' in v)));
});

test('listVersions only returns the requested kind', async () => {
  const { store } = make();
  await tx(store, (s) => store.createSnapshot('workflows', 'v1', [], 'c', s));
  await tx(store, (s) => store.createSnapshot('prompts', 'v1', [], 'c', s));
  assert.equal((await store.listVersions('prompts')).length, 1);
});

test('getVersion falls back to legacy manifest.docs when the kind collection has no rows', async () => {
  const { client, store } = make();
  client.col(cols.manifests).docs.push({
    kind: 'workflows', versionId: 'old', docs: [{ localId: 'l', name: 'L', body: { z: 1 }, checksum: 'cz', extra: 1 }],
  });
  assert.deepEqual(await store.getVersion('workflows', 'old'), [{ localId: 'l', name: 'L', body: { z: 1 }, checksum: 'cz' }]);
  assert.deepEqual(await store.getVersion('workflows', 'missing'), []);
});

test('markActive flips exactly one', async () => {
  const { store } = make();
  for (const v of ['v1', 'v2', 'v3']) await tx(store, (s) => store.createSnapshot('workflows', v, [], 'c', s));
  await tx(store, (s) => store.createSnapshot('prompts', 'v1', [], 'c', s));
  await tx(store, (s) => store.markActive('workflows', 'v1', s));
  await tx(store, (s) => store.markActive('workflows', 'v2', s));
  const active = (await store.listVersions('workflows')).filter((v) => v.isActive).map((v) => v.versionId);
  assert.deepEqual(active, ['v2']);
  assert.equal((await store.listVersions('prompts'))[0].isActive, false);
});

test('dropVersion removes the manifest and that version\'s rows only', async () => {
  const { store } = make();
  const docs = [{ localId: 'a', name: 'A', body: {}, checksum: 'c' }];
  await tx(store, (s) => store.createSnapshot('workflows', 'v1', docs, 'c1', s));
  await tx(store, (s) => store.createSnapshot('workflows', 'v2', docs, 'c2', s));
  await tx(store, (s) => store.dropVersion('workflows', 'v1', s));
  assert.deepEqual((await store.listVersions('workflows')).map((v) => v.versionId), ['v2']);
  assert.deepEqual(await store.getVersion('workflows', 'v1'), []);
  assert.deepEqual(await store.getVersion('workflows', 'v2'), docs);
});

test('putDefinitions/getDefinitions round-trip; replaces per {env,kind}', async () => {
  const { store } = make();
  await tx(store, (s) => store.putDefinitions('dev', 'workflows', { a: 'n1', b: 'n2' }, s));
  await tx(store, (s) => store.putDefinitions('prod', 'workflows', { a: 'p1' }, s));
  assert.deepEqual(await store.getDefinitions('dev', 'workflows'), { a: 'n1', b: 'n2' });
  await tx(store, (s) => store.putDefinitions('dev', 'workflows', { c: 'n3' }, s));
  assert.deepEqual(await store.getDefinitions('dev', 'workflows'), { c: 'n3' });
  assert.deepEqual(await store.getDefinitions('prod', 'workflows'), { a: 'p1' });
  await tx(store, (s) => store.putDefinitions('dev', 'workflows', {}, s)); // empty -> nothing inserted
  assert.deepEqual(await store.getDefinitions('dev', 'workflows'), {});
});

test('getDefinitions reads a legacy single doc carrying `mapping`, and skips unusable rows', async () => {
  const { client, store } = make();
  client.col(cols.definitions).docs.push(
    { env: 'dev', kind: 'workflows', mapping: { old1: 'x', old2: 'y' } },
    { env: 'dev', kind: 'workflows', localId: 'new1', value: 'z' },
    { env: 'dev', kind: 'workflows' }, // neither localId nor mapping
  );
  assert.deepEqual(await store.getDefinitions('dev', 'workflows'), { old1: 'x', old2: 'y', new1: 'z' });
});

test('withTransaction passes a session, returns the result and ends the session', async () => {
  const { client, store } = make();
  const r = await store.withTransaction(async (s) => { assert.equal(s.id, 'sess-1'); return 42; });
  assert.equal(r, 42);
  assert.equal(client.endSessionCalls, 1);
});

test('withTransaction falls back to a default session id when the driver has none', async () => {
  const { client, store } = make();
  client.sessionId = undefined;
  assert.equal(await store.withTransaction(async (s) => s.id), 'm');
});

test('withTransaction ends the session even when the callback throws', async () => {
  const { client, store } = make();
  await assert.rejects(store.withTransaction(async () => { throw new Error('boom'); }), /boom/);
  assert.equal(client.endSessionCalls, 1);
});

test('init creates indexes and reports replicaSet from hello', async () => {
  const { client, store } = make();
  const r = await store.init();
  assert.equal(r.replicaSet, true);
  assert.equal(r.indexes.length, 2 + 3 * 2 + 1 + 2);
  assert.ok(r.indexes.includes(`${cols.definitions}{env,kind,localId}`));
  assert.ok(r.indexes.includes(`${cols.manifests}{kind,checksum}`));
  assert.ok(r.indexes.includes(`${cols.promptContents}{live:key}`));
  assert.equal(client.col(cols.definitions).created.length, 2);
  assert.equal(client.col(cols.manifests).created.length, 2);
  assert.equal(client.col(cols.workflows).created.length, 2);
  assert.equal(client.col(cols.promptContents).created.length, 1);
  assert.deepEqual((client.col(cols.manifests).created[0].options), { unique: true });
});

test('init: replicaSet false when setName is unset', async () => {
  const { client, store } = make();
  client.hello = { ok: 1 };
  assert.equal((await store.init()).replicaSet, false);
});

test('init: replicaSet false when the hello command throws', async () => {
  const { client, store } = make();
  client.hello = new Error('not authorized');
  assert.equal((await store.init()).replicaSet, false);
});

test('backupDb: names, find, listIndexes, recreate, insert, createIndex', async () => {
  const { client, store } = make();
  const b = store.backupDb();
  assert.deepEqual(b.names(), Object.values(cols));

  client.col(cols.workflows).docs.push({ a: 1 }, { a: 2 });
  assert.deepEqual(await b.find(cols.workflows), [{ a: 1 }, { a: 2 }]);

  client.col(cols.workflows).indexList = [
    { name: '_id_', key: { _id: 1 } },
    { name: 'k_1', key: { k: 1 }, unique: true, sparse: false, partialFilterExpression: { k: { $exists: true } }, expireAfterSeconds: 5, v: 2, ns: 'x' },
    { name: 'plain', key: { p: -1 } },
  ];
  assert.deepEqual(await b.listIndexes(cols.workflows), [
    { name: 'k_1', key: { k: 1 }, options: { unique: true, partialFilterExpression: { k: { $exists: true } }, sparse: false, expireAfterSeconds: 5 } },
    { name: 'plain', key: { p: -1 }, options: {} },
  ]);

  client.col(cols.prompts).indexList = new Error('ns does not exist');
  assert.deepEqual(await b.listIndexes(cols.prompts), []);

  await b.recreate(cols.workflows);
  assert.equal(client.col(cols.workflows).dropped, true);
  client.col(cols.workflows).dropError = new Error('ns not found');
  await b.recreate(cols.workflows); // swallowed

  await b.insert(cols.credentials, []); // empty -> skipped
  assert.equal(client.col(cols.credentials).docs.length, 0);
  await b.insert(cols.credentials, [{ q: 1 }]);
  assert.equal(client.col(cols.credentials).docs.length, 1);

  await b.createIndex(cols.credentials, { name: 'n1', key: { q: 1 }, options: { unique: true } });
  await b.createIndex(cols.credentials, { name: 'n2', key: { q: -1 } });
  assert.deepEqual(client.col(cols.credentials).created, [
    { key: { q: 1 }, options: { name: 'n1', unique: true } },
    { key: { q: -1 }, options: { name: 'n2' } },
  ]);
});

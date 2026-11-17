import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildContext } from '../src/context.ts';
import { computePlan, readState, type State } from '../src/engine/state.ts';
import { applyFromState } from '../src/engine/apply-state.ts';
import { refreshedServerFacts, verifyBeforeApply } from '../src/engine/verify.ts';
import { buildProgram } from '../src/cli.ts';
import type { EntityContext } from '../src/entities/types.ts';
import type { Store } from '../src/store/store.ts';

// --- fixtures ---------------------------------------------------------------

interface Call { method: string; url: string; body?: any }

// A stateful fake n8n on 127.0.0.1: it records every call and keeps what it was
// sent, so a later listing (plan, the drift gate, the post-apply refresh) sees
// what an earlier apply created. `failing` holds "METHOD /path" prefixes answered
// 503 while present: the transient failure a retry exists for.
async function startFake() {
  const calls: Call[] = [];
  const workflows: any[] = [];
  const credentials: any[] = [];
  const failing = new Set<string>();
  let wfSeq = 0; let credSeq = 0; let clock = 0;
  const stamp = () => `2026-01-01T00:00:${String(++clock).padStart(2, '0')}.000Z`;
  const srv = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const method = req.method!; const url = req.url!;
      const body = raw ? JSON.parse(raw) : undefined;
      calls.push({ method, url, body });
      const send = (status: number, payload: unknown) => {
        res.statusCode = status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(payload));
      };
      if ([...failing].some((f) => `${method} ${url}`.startsWith(f))) return send(503, { message: 'service unavailable' });
      if (method === 'GET' && url.startsWith('/api/v1/workflows')) return send(200, { data: workflows, nextCursor: null });
      if (method === 'POST' && url === '/api/v1/workflows') {
        const w = { ...body, id: `W${++wfSeq}`, active: false, updatedAt: stamp() };
        workflows.push(w);
        return send(200, w);
      }
      if (method === 'PUT' && url.startsWith('/api/v1/workflows/')) {
        const w = workflows.find((x) => x.id === url.split('/').pop());
        if (!w) return send(404, { message: 'workflow not found' });
        Object.assign(w, body, { updatedAt: stamp() });
        return send(200, w);
      }
      if (method === 'GET' && url.startsWith('/api/v1/credentials')) return send(200, { data: credentials, nextCursor: null });
      if (method === 'POST' && url === '/api/v1/credentials') {
        const c = { id: `C${++credSeq}`, name: body.name, type: body.type, updatedAt: stamp() };
        credentials.push(c);
        return send(200, c);
      }
      if (method === 'PATCH' && url.startsWith('/api/v1/credentials/')) {
        const c = credentials.find((x) => x.id === url.split('/').pop());
        if (!c) return send(404, { message: 'credential not found' });
        Object.assign(c, { name: body.name, type: body.type, updatedAt: stamp() });
        return send(200, c);
      }
      if (method === 'DELETE' && url.startsWith('/api/v1/credentials/')) {
        const i = credentials.findIndex((x) => x.id === url.split('/').pop());
        if (i < 0) return send(404, { message: 'credential not found' });
        return send(200, credentials.splice(i, 1)[0]);
      }
      return send(404, { message: `fake n8n has no route for ${method} ${url}` });
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  return {
    base: `http://127.0.0.1:${(srv.address() as any).port}`,
    calls, workflows, credentials, failing,
    count: (method: string, url: string) => calls.filter((c) => c.method === method && c.url === url).length,
    writes: () => calls.filter((c) => c.method !== 'GET').length,
    close: () => new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); }),
  };
}

function put(root: string, kind: string, id: string, name: string, body: unknown): void {
  const dir = join(root, kind, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'metadata.json'), JSON.stringify({ name }));
  writeFileSync(join(dir, 'apply.ts'), `export default ${JSON.stringify(body)};\n`);
}

const ENV_KEYS = ['N8N_BASE', 'N8N_API_KEY', 'SQLITE_PATH', 'MONGO_URI', 'MONGO_DB', 'N8C_CREDENTIAL_ENCRYPTION_KEY'];

// One project per test, wired the way every command wires itself: buildContext()
// reads N8N_BASE and SQLITE_PATH and returns the real n8n client (pointed at the
// fake) and the default sqlite store. Going through it, rather than importing the
// client class, keeps this file independent of where the client lives.
//
// The project holds one credential and one workflow whose node uses it: the shape
// where the credential has to exist on n8n before the workflow can bind it.
async function setup(t: TestContext) {
  const prevCwd = process.cwd();
  const prevEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  const dir = mkdtempSync(join(tmpdir(), 'n8c-apply-'));
  let fake: Awaited<ReturnType<typeof startFake>> | undefined;
  let store: Store | undefined;
  // a single hook, in a fixed order: close what is open, restore the process, delete
  t.after(async () => {
    await store?.close();
    await fake?.close();
    process.chdir(prevCwd);
    for (const [k, v] of Object.entries(prevEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    process.exitCode = undefined;
    rmSync(dir, { recursive: true, force: true });
  });
  for (const k of ENV_KEYS) delete process.env[k]; // nothing may leak in from the developer's shell
  fake = await startFake();
  const root = join(dir, 'n8c');
  put(root, 'credentials', 'c1', 'API', { name: 'API', type: 'httpHeaderAuth' });
  put(root, 'workflows', 'w1', 'Main', {
    name: 'Main', connections: {},
    nodes: [{ id: 'n1', name: 'Call', type: 'n8n-nodes-base.httpRequest', typeVersion: 4, position: [0, 0], parameters: {},
      credentials: { httpHeaderAuth: { id: 'c1', name: 'API' } } }],
  });
  process.env.SQLITE_PATH = join(dir, 'n8c.sqlite');
  process.env.N8N_BASE = fake.base;
  process.env.N8N_API_KEY = 'test-key';
  const built = await buildContext(dir, 'workflows');
  store = built.store;
  await store.init();
  const ctx = built.ctx;
  const offline: EntityContext = { ...ctx, n8n: undefined };
  return { dir, root, fake, store, ctx, offline };
}

// What `n8c apply` does between attempts: the state is written to disk and the
// next run reads it back.
const roundTrip = (s: State): State => JSON.parse(JSON.stringify(s));

const rowsOf = (s: State) => s.resources.map((r) => `${r.kind}:${r.localId}:${r.action}`);

function savedState(resources: State['resources'], applied: State['applied'] = null): State {
  const summary = { create: 0, update: 0, noop: 0, delete: 0 };
  for (const r of resources) summary[r.action]++;
  return { env: 'default', n8cVersion: '0', createdAt: '', desiredChecksum: '', summary, resources, applied };
}

// --- 1. a retry never re-applies what an earlier attempt applied ------------

test('retrying a partially-applied plan does not create its credential a second time', async (t) => {
  const { root, fake, store, ctx } = await setup(t);
  const plan = await computePlan(store, root, ctx, { version: '0' });
  assert.deepEqual(rowsOf(plan), ['credentials:c1:create', 'workflows:w1:create']);

  // attempt 1: the credential is created, then n8n hiccups on the workflow
  fake.failing.add('POST /api/v1/workflows');
  const first = await applyFromState(store, root, ctx, plan);
  assert.deepEqual(first.applied!.ok, ['c1']);
  assert.deepEqual(first.applied!.failed.map((f) => f.localId), ['w1']);
  assert.equal(fake.credentials.length, 1);

  // attempt 2: the same saved plan, read back from disk
  fake.failing.clear();
  const retry = await applyFromState(store, root, ctx, roundTrip(first));
  assert.equal(fake.count('POST', '/api/v1/credentials'), 1, 'the retry must not POST the credential again');
  assert.equal(fake.credentials.length, 1, 'exactly one credential on n8n');
  assert.deepEqual(retry.applied!.ok, ['w1'], 'only what was left is applied');
  assert.deepEqual(retry.applied!.failed, []);
  // …and the workflow binds the credential attempt 1 created, not a new one
  const [cred] = fake.credentials;
  assert.deepEqual(fake.workflows.map((w) => w.nodes[0].credentials.httpHeaderAuth), [{ id: cred.id, name: 'API' }]);
  assert.deepEqual(await store.getDefinitions('default', 'credentials'), { c1: { id: cred.id, name: 'API', updatedAt: cred.updatedAt } });
});

test('re-applying a plan that already applied in full writes nothing to n8n and records no new release', async (t) => {
  const { root, fake, store, ctx } = await setup(t);
  const first = await applyFromState(store, root, ctx, await computePlan(store, root, ctx, { version: '0' }));
  assert.deepEqual(first.applied!.ok, ['c1', 'w1']);
  const writes = fake.writes();
  const releases = (await store.listVersions('credentials')).length;

  const again = await applyFromState(store, root, ctx, roundTrip(first));
  assert.equal(fake.writes(), writes, 'no create, update or republish reaches n8n');
  assert.equal(fake.credentials.length, 1, 'no duplicate credential');
  assert.deepEqual(again.applied!.ok, []);
  assert.deepEqual(again.applied!.failed, []);
  assert.equal((await store.listVersions('credentials')).length, releases, 'no empty release');
});

// Skipping an applied row is safe only because the drift gate still looks at it:
// the workflow left to retry binds the credential attempt 1 created, so a change
// to that credential on n8n since must stop the retry, not slip past it.
test('the drift gate still checks rows an earlier attempt applied: a retry stops if one changed on n8n since', async (t) => {
  const { root, fake, store, ctx } = await setup(t);
  fake.failing.add('POST /api/v1/workflows');
  const first = await applyFromState(store, root, ctx, await computePlan(store, root, ctx, { version: '0' }));
  assert.equal(first.resources.find((r) => r.localId === 'c1')!.appliedAt, first.applied!.at);
  first.serverFacts = await refreshedServerFacts(ctx); // what the CLI does after every apply

  fake.credentials[0].updatedAt = '2026-02-02T00:00:00.000Z'; // edited in the n8n UI
  const outcome = await verifyBeforeApply(ctx, roundTrip(first));
  assert.equal(outcome.decision, 'block');
  assert.deepEqual(outcome.drift.map((d) => `${d.kind}:${d.name}:${d.change}`), ['credentials:API:changed']);
});

// --- 2. no n8n connection: refuse server-backed rows, commit nothing ---------

test('without an n8n connection, a plan with credential/workflow changes is refused and nothing is committed', async (t) => {
  const { root, store, ctx, offline } = await setup(t);
  // planned WITH n8n (a plan always is), applied without it
  const plan = await computePlan(store, root, ctx, { version: '0' });

  await assert.rejects(applyFromState(store, root, offline, plan), /n8n connection/);
  assert.equal(plan.applied, null, 'no apply result recorded');
  assert.deepEqual(await store.getLive('credentials'), [], 'no credential claimed deployed');
  assert.deepEqual(await store.getLive('workflows'), [], 'no workflow claimed deployed');
  assert.deepEqual(await store.getDefinitions('default', 'credentials'), {});
  assert.deepEqual(await store.listVersions('workflows'), [], 'no release');
});

test('without an n8n connection, a server delete is refused: the credential stays mapped and live', async (t) => {
  const { root, store, offline } = await setup(t);
  const mapping = { c2: { id: 'C9', name: 'Old', updatedAt: 'T' } };
  const live = [{ localId: 'c2', name: 'Old', body: { name: 'Old', type: 'httpHeaderAuth' }, checksum: 'x' }];
  await store.withTransaction((s) => store.putDefinitions('default', 'credentials', mapping, s));
  await store.withTransaction((s) => store.putLive('credentials', live, s));
  const state = savedState([{ kind: 'credentials', localId: 'c2', name: 'Old', action: 'delete', fromChecksum: 'x', toChecksum: null }]);

  await assert.rejects(applyFromState(store, root, offline, state), /n8n connection/);
  // dropping these while C9 stays on n8n would leave it there, unmapped and unplanned, for good
  assert.deepEqual(await store.getDefinitions('default', 'credentials'), mapping);
  assert.deepEqual(await store.getLive('credentials'), live);
  assert.equal(state.applied, null);
});

test('without an n8n connection, DB-only changes still apply (credential/workflow rows that are noop need no server)', async (t) => {
  const { root, store, offline } = await setup(t);
  put(root, 'prompts', 'p1', 'greet', { key: 'greet', content: 'hi' });
  const state = savedState([
    { kind: 'prompts', localId: 'p1', name: 'greet', action: 'create', fromChecksum: null, toChecksum: 'x' },
    { kind: 'workflows', localId: 'w1', name: 'Main', action: 'noop', fromChecksum: 'y', toChecksum: 'y' },
  ]);

  const done = await applyFromState(store, root, offline, state);
  assert.deepEqual(done.applied!.ok, ['p1']);
  assert.equal(((await store.getLive('prompts'))[0].body as any).content, 'hi');
});

test('without an n8n connection, a resumed plan whose remaining rows are DB-only still applies', async (t) => {
  const { root, store, offline } = await setup(t);
  put(root, 'prompts', 'p1', 'greet', { key: 'greet', content: 'hi' });
  const earlier = '2026-01-01T00:00:00.000Z';
  const state = savedState([
    // carried out by an earlier attempt, which then failed on the prompt
    { kind: 'credentials', localId: 'c1', name: 'API', action: 'create', fromChecksum: null, toChecksum: 'x', appliedAt: earlier },
    { kind: 'prompts', localId: 'p1', name: 'greet', action: 'create', fromChecksum: null, toChecksum: 'y' },
  ], { at: earlier, ok: ['c1'], failed: [{ localId: 'p1', error: 'store unavailable' }] });

  const done = await applyFromState(store, root, offline, state);
  assert.deepEqual(done.applied!.ok, ['p1']);
  assert.deepEqual(await store.getLive('credentials'), [], 'the stamped credential row is not run again');
  assert.equal(done.resources[0].appliedAt, earlier, 'an earlier stamp is kept');
});

// --- the delete path's fallbacks ---------------------------------------------

test('a credential delete resolves a legacy plain-string mapping to its n8n id', async (t) => {
  const { root, fake, store, ctx } = await setup(t);
  fake.credentials.push({ id: 'C7', name: 'Old', type: 'httpHeaderAuth', updatedAt: 'T' });
  await store.withTransaction((s) => store.putDefinitions('default', 'credentials', { c2: 'C7' }, s));
  const state = savedState([{ kind: 'credentials', localId: 'c2', name: 'Old', action: 'delete', fromChecksum: 'x', toChecksum: null }]);

  const done = await applyFromState(store, root, ctx, state);
  assert.deepEqual(done.applied!.ok, ['c2']);
  assert.equal(fake.count('DELETE', '/api/v1/credentials/C7'), 1);
  assert.deepEqual(fake.credentials, []);
  assert.deepEqual(await store.getDefinitions('default', 'credentials'), {});
});

test('a prompt delete needs no n8n: it only drops the live doc', async (t) => {
  const { root, store, offline } = await setup(t);
  await store.withTransaction((s) => store.putLive('prompts', [{ localId: 'p9', name: 'old', body: { key: 'old', content: 'x' }, checksum: 'x' }], s));
  const state = savedState([{ kind: 'prompts', localId: 'p9', name: 'old', action: 'delete', fromChecksum: 'x', toChecksum: null }]);

  const done = await applyFromState(store, root, offline, state);
  assert.deepEqual(done.applied!.ok, ['p9']);
  assert.deepEqual(await store.getLive('prompts'), []);
});

test('a credential delete rejected with a non-Error 404 still counts as already gone', async (t) => {
  const { root, store, ctx } = await setup(t);
  await store.withTransaction((s) => store.putDefinitions('default', 'credentials', { c2: { id: 'C7', name: 'Old' } }, s));
  const state = savedState([{ kind: 'credentials', localId: 'c2', name: 'Old', action: 'delete', fromChecksum: 'x', toChecksum: null }]);
  // defensive fallback: a rejection that is a bare string has no .message
  const n8n = { deleteCredential: async () => { throw 'DELETE /api/v1/credentials/C7 -> 404'; } } as any;

  const done = await applyFromState(store, root, { ...ctx, n8n }, state);
  assert.deepEqual(done.applied!.ok, ['c2']);
  assert.deepEqual(await store.getDefinitions('default', 'credentials'), {});
});

// --- the same two scenarios through the CLI, in-process ----------------------

const cli = (...args: string[]) => buildProgram().parseAsync(['node', 'n8c', ...args]);

// The CLI finds its project through the cwd (setup's teardown restores it).
function inProject(t: TestContext, dir: string): string[] {
  process.chdir(dir);
  const out: string[] = [];
  t.mock.method(console, 'log', (...a: unknown[]) => { out.push(a.join(' ')); });
  t.mock.method(console, 'error', (...a: unknown[]) => { out.push(a.join(' ')); });
  return out;
}

test('n8c apply: retrying a partially-applied saved plan creates its credential once', async (t) => {
  const { dir, fake } = await setup(t);
  const out = inProject(t, dir);
  await cli('plan');

  fake.failing.add('POST /api/v1/workflows');
  await cli('apply');
  assert.equal(process.exitCode, 1, 'attempt 1 fails on the workflow');
  process.exitCode = undefined;

  fake.failing.clear();
  out.length = 0;
  await cli('apply');
  assert.equal(process.exitCode, undefined, 'the retry succeeds');
  assert.equal(fake.count('POST', '/api/v1/credentials'), 1, 'the retry must not POST the credential again');
  assert.deepEqual(fake.workflows.map((w) => w.nodes[0].credentials.httpHeaderAuth.id), [fake.credentials[0].id]);
  assert.match(out.join('\n'), /resuming this plan — skipping 1 change\(s\) an earlier attempt already applied/);
  const state = readState(dir, 'default');
  assert.deepEqual(state.applied!.ok, ['w1']);
  assert.deepEqual(state.applied!.failed, []);
});

test('n8c apply without N8N_BASE refuses a plan with credential/workflow changes and commits nothing', async (t) => {
  const { dir, fake, store } = await setup(t);
  inProject(t, dir);
  await cli('plan');

  delete process.env.N8N_BASE; delete process.env.N8N_API_KEY;
  await assert.rejects(cli('apply'), /n8n connection.*N8N_BASE/);
  assert.equal(fake.writes(), 0);
  assert.equal(readState(dir, 'default').applied, null, 'the saved plan does not claim an apply');
  assert.deepEqual(await store.getLive('credentials'), []);
  assert.deepEqual(await store.getLive('workflows'), []);
  assert.deepEqual(await store.getDefinitions('default', 'credentials'), {});
  assert.deepEqual(await store.listVersions('workflows'), [], 'no release');
});

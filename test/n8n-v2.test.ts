import { test } from 'node:test';
import assert from 'node:assert/strict';
import { N8nClientV2 } from '../src/n8n/v2.ts';
import { N8nClientV3 } from '../src/n8n/v3.ts';
import { createN8nClient, resolveN8nVersion } from '../src/n8n/index.ts';

type Call = [string, string, any];
type Reply = { status?: number; body?: unknown; text?: string };
const B = 'https://n8n.test/api/v1/workflows';

// A fake fetch that records [method, url, parsed body] and answers with a REAL
// Response, so an empty 204 rejects .json() exactly as it does against n8n.
function make(Cls: typeof N8nClientV2, responder: (method: string, url: string) => Reply = () => ({ body: { id: 'NEW' } }), projectId?: string) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init: any) => {
    calls.push([init.method, url, init.body === undefined ? undefined : JSON.parse(init.body)]);
    const r = responder(init.method, url);
    const status = r.status ?? 200;
    return new Response(status === 204 ? null : r.text ?? JSON.stringify(r.body ?? {}), { status });
  };
  return { calls, client: new Cls('https://n8n.test', 'KEY', fetchImpl as any, projectId) };
}

// A client whose req() throws `err`: lets a test prove updateWorkflow passes on
// that SAME object (identity, not a look-alike copy).
function throwing(Cls: typeof N8nClientV2, err: unknown): N8nClientV2 {
  class Throwing extends Cls { protected async req(): Promise<any> { throw err; } }
  return new Throwing('https://n8n.test', 'KEY');
}
// Shaped like the error req() throws for a failed PUT.
const n8nError = (status: number, body: string) => Object.assign(new Error(`n8n PUT /api/v1/workflows/W1 -> ${status} ${body}`), { status });
const rejection = (p: Promise<unknown>): Promise<any> => p.then(() => assert.fail('expected a rejection'), (e) => e);
const GUIDANCE = /Grant it and re-run `n8c apply` on the SAME saved plan — a fresh `n8c plan` compares against n8n's saved draft and will show no change — or, to deploy without publishing, unpublish the workflow in n8n first AND set `active: false` in its file, then run `n8c pull` to record the version n8n already saved\./;

// ---- Shared behavior: V3 inherits it from V2, so both classes run the same suite.
const classes: [string, typeof N8nClientV2][] = [['V2', N8nClientV2], ['V3', N8nClientV3]];

for (const [name, Cls] of classes) {
  test(`${name}: update 403 whose body names workflow:activate -> DRAFT error with recovery guidance`, async () => {
    const body = '{"message":"API key lacks workflow:activate"}';
    const { client } = make(Cls, () => ({ status: 403, text: body }));
    const e = await rejection(client.updateWorkflow('W1', {}));
    assert.match(e.message, /^n8n saved the new version of workflow W1 as a DRAFT and refused to publish it because the API key lacks the workflow:activate \/ workflow:publish permission\. /);
    assert.match(e.message, GUIDANCE);
    assert.ok(e.message.endsWith(`(n8n PUT /api/v1/workflows/W1 -> 403 ${body})`), 'original error text appended');
    assert.equal(e.status, 403);
    assert.equal(e.cause.message, `n8n PUT /api/v1/workflows/W1 -> 403 ${body}`);
  });

  test(`${name}: update 403 whose body names workflow:publish -> DRAFT error keeping .status, .cause = the original`, async () => {
    const original = n8nError(403, '{"message":"missing scope workflow:publish"}');
    const e = await rejection(throwing(Cls, original).updateWorkflow('W1', {}));
    assert.match(e.message, /as a DRAFT/);
    assert.match(e.message, GUIDANCE);
    assert.equal(e.status, 403);
    assert.equal(e.cause, original);
  });

  test(`${name}: a 403 that does not name the publish permission is rethrown as the same object`, async () => {
    // e.g. the key lacks workflow:update: n8n saved nothing, so there is no draft to claim.
    const original = n8nError(403, '{"message":"Forbidden"}');
    assert.equal(await rejection(throwing(Cls, original).updateWorkflow('W1', {})), original);
  });

  test(`${name}: a non-403 update error is rethrown as the same object`, async () => {
    const original = n8nError(400, 'bad');
    assert.equal(await rejection(throwing(Cls, original).updateWorkflow('W1', {})), original);
  });

  test(`${name}: update success returns the response`, async () => {
    const { client, calls } = make(Cls, () => ({ body: { id: 'W1' } }));
    assert.deepEqual(await client.updateWorkflow('W1', { a: 1 }), { id: 'W1' });
    assert.deepEqual(calls, [['PUT', `${B}/W1`, { a: 1 }]]);
  });

  test(`${name}: listWorkflows maps activeVersionId null/value/absent -> active false/true/raw`, async () => {
    const { client } = make(Cls, () => ({ body: { data: [
      { id: 'a', activeVersionId: null, active: true },
      { id: 'b', activeVersionId: 'v1', active: false },
      { id: 'c', active: true },
    ] } }));
    assert.deepEqual(await client.listWorkflows(), [
      { id: 'a', activeVersionId: null, active: false },
      { id: 'b', activeVersionId: 'v1', active: true },
      { id: 'c', active: true },
    ]);
  });
}

// ---- V2: every n8n 2.x release. /publish, /unpublish and projectId on create only
// arrived during 2.x, so V2 uses what 2.0 onward all serve.

// Create-then-move, shared by both kinds (workflow / credential) on V2.
const kinds = [
  { kind: 'workflow', path: '/api/v1/workflows', scope: 'workflow:move', create: (c: N8nClientV2) => c.createWorkflow({ name: 'X' }) },
  { kind: 'credential', path: '/api/v1/credentials', scope: 'credential:move', create: (c: N8nClientV2) => c.createCredential({ name: 'X' }) },
];
const API = 'https://n8n.test';

for (const { kind, path, scope, create } of kinds) {
  test(`V2: create ${kind} POSTs the body unchanged, then moves it into the project`, async () => {
    // n8n answers the transfer with 204 and no body.
    const { client, calls } = make(N8nClientV2, (m) => (m === 'PUT' ? { status: 204 } : { body: { id: 'NEW', name: 'X' } }), 'PROJ1');
    assert.deepEqual(await create(client), { id: 'NEW', name: 'X' });
    assert.deepEqual(calls, [
      ['POST', API + path, { name: 'X' }],
      ['PUT', `${API}${path}/NEW/transfer`, { destinationProjectId: 'PROJ1' }],
    ]);
  });

  test(`V2: create ${kind} without projectId makes no transfer call`, async () => {
    const { client, calls } = make(N8nClientV2);
    assert.deepEqual(await create(client), { id: 'NEW' });
    assert.deepEqual(calls, [['POST', API + path, { name: 'X' }]]);
  });

  test(`V2: create ${kind} makes no transfer call when n8n returns no id`, async () => {
    const { client, calls } = make(N8nClientV2, () => ({ body: {} }), 'PROJ1');
    assert.deepEqual(await create(client), {});
    assert.deepEqual(calls, [['POST', API + path, { name: 'X' }]]);
  });

  test(`V2: create ${kind} treats "already owning it" on the move as success and keeps the item`, async () => {
    const text = `{"message":"You can't transfer a ${kind} into the project that's already owning it."}`;
    const { client, calls } = make(N8nClientV2, (m) => (m === 'PUT' ? { status: 400, text } : { body: { id: 'NEW' } }), 'PROJ1');
    assert.deepEqual(await create(client), { id: 'NEW' });
    assert.deepEqual(calls.map((c) => c[0]), ['POST', 'PUT'], 'no DELETE');
  });

  test(`V2: create ${kind} whose move fails deletes the new item and throws naming id, project and ${scope}`, async () => {
    const { client, calls } = make(N8nClientV2, (m) => (m === 'PUT' ? { status: 403, text: 'Forbidden' } : m === 'DELETE' ? { body: {} } : { body: { id: 'NEW' } }), 'PROJ1');
    const e = await rejection(create(client));
    assert.deepEqual(calls.map((c) => [c[0], c[1]]), [['POST', API + path], ['PUT', `${API}${path}/NEW/transfer`], ['DELETE', `${API}${path}/NEW`]]);
    assert.match(e.message, new RegExp(`${kind}`));
    assert.match(e.message, /NEW/);
    assert.match(e.message, /PROJ1/);
    assert.ok(e.message.includes(scope), e.message);
    assert.equal(e.status, 403);
    assert.match(e.message, new RegExp(`The API key most likely lacks the ${scope} scope`));
    assert.match(e.cause.message, /-> 403 Forbidden/);
    assert.equal(e.cause.status, 403);
  });

  test(`V2: create ${kind} whose move AND rollback fail reports the orphaned id with both errors`, async () => {
    const { client } = make(N8nClientV2, (m) => (m === 'PUT' ? { status: 403, text: 'no scope' } : m === 'DELETE' ? { status: 500, text: 'boom' } : { body: { id: 'NEW' } }), 'PROJ1');
    const e = await rejection(create(client));
    assert.match(e.message, new RegExp(`${kind} NEW was left in the API key's personal project and must be removed by hand`));
    assert.match(e.message, /403 no scope/);
    assert.match(e.message, /500 boom/);
    assert.ok(e.message.includes(scope));
    assert.equal(e.status, 403);
    assert.equal(e.cause.status, 403);
  });

  test(`V2: create ${kind} whose move fails with a 400 other than "already owning it" still rolls back`, async () => {
    const { client, calls } = make(N8nClientV2, (m) => (m === 'PUT' ? { status: 400, text: 'bad project' } : { body: { id: 'NEW' } }), 'PROJ1');
    const e = await rejection(create(client));
    assert.equal(calls.at(-1)![0], 'DELETE');
    assert.equal(e.status, 400);
    assert.match(e.message, /Check that n8nProjectId PROJ1 exists and the API key can access it/);
    assert.ok(e.message.includes(`moving needs the ${scope} scope`), e.message);
    assert.doesNotMatch(e.message, /most likely lacks/);
  });
}

test('V2: activate -> /activate, deactivate -> /deactivate', async () => {
  const { client, calls } = make(N8nClientV2);
  await client.activateWorkflow('W1');
  await client.deactivateWorkflow('W1');
  assert.deepEqual(calls, [['POST', `${B}/W1/activate`, undefined], ['POST', `${B}/W1/deactivate`, undefined]]);
});

// ---- V3: n8n 3.x. These endpoints also exist from n8n 2.33.

test('V3: createWorkflow puts projectId in the POST body and never calls /transfer', async () => {
  const { client, calls } = make(N8nClientV3, undefined, 'PROJ1');
  assert.deepEqual(await client.createWorkflow({ name: 'W' }), { id: 'NEW' });
  assert.deepEqual(calls, [['POST', B, { name: 'W', projectId: 'PROJ1' }]]);
});

test('V3: createWorkflow without projectId sends the body unchanged', async () => {
  const { client, calls } = make(N8nClientV3);
  await client.createWorkflow({ name: 'W' });
  assert.deepEqual(calls, [['POST', B, { name: 'W' }]]);
});

test('V3: createCredential puts projectId in the POST body and never calls /transfer', async () => {
  const { client, calls } = make(N8nClientV3, undefined, 'PROJ1');
  assert.deepEqual(await client.createCredential({ name: 'C' }), { id: 'NEW' });
  assert.deepEqual(calls, [['POST', `${API}/api/v1/credentials`, { name: 'C', projectId: 'PROJ1' }]]);
});

test('V3: createCredential without projectId sends the body unchanged', async () => {
  const { client, calls } = make(N8nClientV3);
  await client.createCredential({ name: 'C' });
  assert.deepEqual(calls, [['POST', `${API}/api/v1/credentials`, { name: 'C' }]]);
});

test('V3: activate -> /publish, deactivate -> /unpublish', async () => {
  const { client, calls } = make(N8nClientV3);
  await client.activateWorkflow('W1');
  await client.deactivateWorkflow('W1');
  assert.deepEqual(calls, [['POST', `${B}/W1/publish`, undefined], ['POST', `${B}/W1/unpublish`, undefined]]);
});

test('resolveN8nVersion: defaults to 3, accepts 2/3 as string or number, rejects others', () => {
  assert.equal(resolveN8nVersion(undefined), '3');
  assert.equal(resolveN8nVersion(null), '3');
  assert.equal(resolveN8nVersion('2'), '2');
  assert.equal(resolveN8nVersion(2), '2');
  assert.equal(resolveN8nVersion('3'), '3');
  assert.equal(resolveN8nVersion(3), '3');
  for (const bad of ['1', 'x', 4]) assert.throws(() => resolveN8nVersion(bad), /n8c supports n8n 2 and 3/);
});

test('createN8nClient picks the class by version', () => {
  const two = createN8nClient('2', 'https://n8n.test', 'K');
  assert.ok(two instanceof N8nClientV2);
  assert.ok(!(two instanceof N8nClientV3));
  assert.ok(createN8nClient('3', 'https://n8n.test', 'K') instanceof N8nClientV3);
});

// ---- archiveWorkflow: n8n 2.0-2.14 has no archive route, so a 404 there is ambiguous.
const status = (s: number) => (method: string, url: string): Reply =>
  url.endsWith('/archive') ? { status: s, text: '{"message":"Not Found"}' } : { body: {} };

for (const [name, Cls] of classes) {
  test(`${name}: archiveWorkflow sends only the archive POST when it succeeds`, async () => {
    const { client, calls } = make(Cls);
    await client.archiveWorkflow('W1');
    assert.deepEqual(calls, [['POST', `${B}/W1/archive`, undefined]]);
  });

  test(`${name}: archive 404 + GET 200 (no archive endpoint) permanently deletes and warns`, async (t) => {
    const errs: string[] = [];
    t.mock.method(console, 'error', (...a: unknown[]) => { errs.push(a.join(' ')); });
    const { client, calls } = make(Cls, (m, u) => (u.endsWith('/archive') ? { status: 404, text: '{"message":"Not Found"}' } : { body: { id: 'W1' } }));
    await client.archiveWorkflow('W1');
    assert.deepEqual(calls.map((c) => [c[0], c[1]]), [['POST', `${B}/W1/archive`], ['GET', `${B}/W1`], ['DELETE', `${B}/W1`]]);
    assert.deepEqual(errs, ['  ⚠ workflow W1 was permanently deleted because this n8n has no archive endpoint (n8n 2.15+ archives instead).']);
  });

  for (const failing of [404, 500]) {
    test(`${name}: archive 404 + GET 200 + fallback DELETE ${failing} rejects, not as a 404, and prints no deleted warning`, async (t) => {
      const errs: string[] = [];
      t.mock.method(console, 'error', (...a: unknown[]) => { errs.push(a.join(' ')); });
      const { client } = make(Cls, (m, u) => (u.endsWith('/archive') ? { status: 404, text: '{"message":"Not Found"}' } : m === 'DELETE' ? { status: failing, text: '{"message":"nope"}' } : { body: { id: 'W1' } }));
      const e = await rejection(client.archiveWorkflow('W1'));
      assert.notEqual(e.status, 404);
      assert.match(e.message, /W1/);
      assert.equal(e.cause.status, failing);
      assert.deepEqual(errs, []);
    });
  }

  test(`${name}: archive 404 + GET 404 rethrows the original archive error`, async () => {
    const { client, calls } = make(Cls, () => ({ status: 404, text: '{"message":"Not Found"}' }));
    const e = await rejection(client.archiveWorkflow('W1'));
    assert.equal(e.status, 404);
    assert.match(e.message, /POST \/api\/v1\/workflows\/W1\/archive -> 404/);
    assert.deepEqual(calls.map((c) => c[0]), ['POST', 'GET']);
  });

  test(`${name}: archive 404 + GET 404 rejects with the very error the archive threw`, async () => {
    const original = Object.assign(new Error('archive 404'), { status: 404 });
    class Fake extends Cls { protected async req(m: string): Promise<any> { throw m === 'POST' ? original : Object.assign(new Error('gone'), { status: 404 }); } }
    assert.equal(await rejection(new Fake('https://n8n.test', 'KEY').archiveWorkflow('W1')), original);
  });

  test(`${name}: archive 500 is rethrown unchanged with no GET`, async () => {
    const { client, calls } = make(Cls, status(500));
    const e = await rejection(client.archiveWorkflow('W1'));
    assert.equal(e.status, 500);
    assert.deepEqual(calls.map((c) => c[0]), ['POST']);
  });

  test(`${name}: archive 404 + GET 500 rejects with the GET's error, never the archive 404`, async () => {
    const { client } = make(Cls, (m, u) => (u.endsWith('/archive') ? { status: 404, text: 'nf' } : { status: 500, text: 'boom' }));
    const e = await rejection(client.archiveWorkflow('W1'));
    assert.equal(e.status, 500);
    assert.match(e.message, /GET \/api\/v1\/workflows\/W1 -> 500/);
  });
}

test('V3 inherits the archive fallback from V2', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { client, calls } = make(N8nClientV3, (m, u) => (u.endsWith('/archive') ? { status: 404 } : { body: {} }));
  await client.archiveWorkflow('W1');
  assert.equal(calls.at(-1)![0], 'DELETE');
});

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

// ---- Shared behavior: V3 inherits it from V2, so both classes run the same suite.
const classes: [string, typeof N8nClientV2][] = [['V2', N8nClientV2], ['V3', N8nClientV3]];

for (const [name, Cls] of classes) {
  test(`${name}: update 403 -> draft-explaining error naming workflow:activate`, async () => {
    const { client } = make(Cls, () => ({ status: 403, text: 'forbidden' }));
    await assert.rejects(() => client.updateWorkflow('W1', {}), (e: any) => {
      assert.match(e.message, /saved the new version of workflow W1 as a DRAFT/);
      assert.match(e.message, /workflow:activate/);
      assert.match(e.message, /n8n PUT \/api\/v1\/workflows\/W1 -> 403 forbidden/);
      return true;
    });
  });

  test(`${name}: update non-403 error is rethrown untouched`, async () => {
    const { client } = make(Cls, () => ({ status: 400, text: 'bad' }));
    let thrown: any;
    await client.updateWorkflow('W1', {}).catch((e) => { thrown = e; });
    assert.equal(thrown.status, 400);
    assert.equal(thrown.message, 'n8n PUT /api/v1/workflows/W1 -> 400 bad');
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

test('V2: createWorkflow POSTs the body unchanged, then transfers the new workflow to the project', async () => {
  // n8n answers the transfer with 204 and no body.
  const { client, calls } = make(N8nClientV2, (m) => (m === 'PUT' ? { status: 204 } : { body: { id: 'NEW', name: 'W' } }), 'PROJ1');
  assert.deepEqual(await client.createWorkflow({ name: 'W' }), { id: 'NEW', name: 'W' });
  assert.deepEqual(calls, [
    ['POST', B, { name: 'W' }],
    ['PUT', `${B}/NEW/transfer`, { destinationProjectId: 'PROJ1' }],
  ]);
});

test('V2: createWorkflow without projectId makes no transfer call', async () => {
  const { client, calls } = make(N8nClientV2);
  assert.deepEqual(await client.createWorkflow({ name: 'W' }), { id: 'NEW' });
  assert.deepEqual(calls, [['POST', B, { name: 'W' }]]);
});

test('V2: createWorkflow makes no transfer call when n8n returns no id', async () => {
  const { client, calls } = make(N8nClientV2, () => ({ body: {} }), 'PROJ1');
  assert.deepEqual(await client.createWorkflow({ name: 'W' }), {});
  assert.deepEqual(calls, [['POST', B, { name: 'W' }]]);
});

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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { N8nClientV2 } from '../src/n8n/v2.ts';
import { N8nClientV3 } from '../src/n8n/v3.ts';
import { createN8nClient, resolveN8nVersion } from '../src/n8n/index.ts';

type Call = [string, string, any];
const B = 'https://n8n.test/api/v1/workflows';

function makeWith(factory: (f: typeof fetch, projectId?: string) => N8nClientV2, responder: (method: string, url: string) => any, projectId?: string) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init: any) => {
    calls.push([init.method, url, init.body === undefined ? undefined : JSON.parse(init.body)]);
    const r = responder(init.method, url);
    return { ok: r.ok ?? true, status: r.status ?? 200, text: async () => r.text ?? '', json: async () => r.body ?? {} } as any;
  };
  return { calls, client: factory(fetchImpl as any, projectId) };
}

const factories: [string, (f: typeof fetch, p?: string) => N8nClientV2][] = [
  ['V2', (f, p) => createN8nClient('2', 'https://n8n.test', 'KEY', f, p)],
  ['V3', (f, p) => createN8nClient('3', 'https://n8n.test', 'KEY', f, p)],
];

for (const [name, factory] of factories) {
  const make = (responder: (m: string, u: string) => any = () => ({ body: { id: 'NEW' } }), projectId?: string) => makeWith(factory, responder, projectId);

  test(`${name}: createWorkflow puts projectId in the POST body and never calls /transfer`, async () => {
    const { client, calls } = make(undefined, 'PROJ1');
    const r = await client.createWorkflow({ name: 'W' });
    assert.equal(r.id, 'NEW');
    assert.deepEqual(calls, [['POST', B, { name: 'W', projectId: 'PROJ1' }]]);
  });

  test(`${name}: createWorkflow without projectId sends body unchanged`, async () => {
    const { client, calls } = make();
    await client.createWorkflow({ name: 'W' });
    assert.deepEqual(calls, [['POST', B, { name: 'W' }]]);
  });

  test(`${name}: activate -> /publish, deactivate -> /unpublish`, async () => {
    const { client, calls } = make();
    await client.activateWorkflow('W1');
    await client.deactivateWorkflow('W1');
    assert.deepEqual(calls, [['POST', `${B}/W1/publish`, undefined], ['POST', `${B}/W1/unpublish`, undefined]]);
  });

  test(`${name}: update 403 -> draft-explaining error naming workflow:activate`, async () => {
    const { client } = make(() => ({ ok: false, status: 403, text: 'forbidden' }));
    await assert.rejects(() => client.updateWorkflow('W1', {}), (e: any) => {
      assert.match(e.message, /saved the new version of workflow W1 as a DRAFT/);
      assert.match(e.message, /workflow:activate/);
      assert.match(e.message, /n8n PUT \/api\/v1\/workflows\/W1 -> 403 forbidden/);
      return true;
    });
  });

  test(`${name}: update non-403 error is rethrown untouched`, async () => {
    const { client } = make(() => ({ ok: false, status: 400, text: 'bad' }));
    let thrown: any;
    await client.updateWorkflow('W1', {}).catch((e) => { thrown = e; });
    assert.equal(thrown.status, 400);
    assert.equal(thrown.message, 'n8n PUT /api/v1/workflows/W1 -> 400 bad');
  });

  test(`${name}: update success returns the response`, async () => {
    const { client, calls } = make(() => ({ body: { id: 'W1' } }));
    assert.deepEqual(await client.updateWorkflow('W1', { a: 1 }), { id: 'W1' });
    assert.deepEqual(calls, [['PUT', `${B}/W1`, { a: 1 }]]);
  });

  test(`${name}: listWorkflows maps activeVersionId null/value/absent -> active false/true/raw`, async () => {
    const { client } = make(() => ({ body: { data: [
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

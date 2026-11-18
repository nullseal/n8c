import { test } from 'node:test';
import assert from 'node:assert/strict';
import { N8nClientBase } from '../src/n8n/base.ts';

class TestClient extends N8nClientBase {
  async createWorkflow(body: unknown): Promise<{ id: string }> { return this.req('POST', '/api/v1/workflows', body); }
  async createCredential(body: unknown): Promise<{ id: string }> { return this.req('POST', '/api/v1/credentials', body); }
  async activateWorkflow(id: string): Promise<any> { return this.req('POST', `/api/v1/workflows/${id}/activate`); }
  async deactivateWorkflow(id: string): Promise<any> { return this.req('POST', `/api/v1/workflows/${id}/deactivate`); }
}

type Call = [string, string, any];
function make(responder: (url: string) => any, projectId?: string, baseUrl = 'https://n8n.test') {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init: any) => {
    calls.push([init.method, url, init.body === undefined ? undefined : JSON.parse(init.body)]);
    const r = responder(url);
    return { ok: r.ok ?? true, status: r.status ?? 200, text: async () => r.text ?? '', json: async () => r.body ?? {} } as any;
  };
  return { calls, client: new TestClient(baseUrl, 'KEY', fetchImpl as any, projectId) };
}

test('sends api key header and trims trailing slash of baseUrl', async () => {
  let headers: any;
  const fetchImpl = async (_u: string, init: any) => { headers = init.headers; return { ok: true, status: 200, json: async () => ({ data: [] }) } as any; };
  const c = new TestClient('https://n8n.test/', 'KEY', fetchImpl as any);
  const urls: string[] = [];
  const f2 = async (u: string) => { urls.push(u); return { ok: true, status: 200, json: async () => ({ data: [] }) } as any; };
  await c.listWorkflows();
  assert.equal(headers['X-N8N-API-KEY'], 'KEY');
  await new TestClient('https://n8n.test/', 'K', f2 as any).listWorkflows();
  assert.equal(urls[0], 'https://n8n.test/api/v1/workflows');
});

test('failed request throws with message and err.status', async () => {
  const { client } = make(() => ({ ok: false, status: 403, text: 'nope' }));
  await assert.rejects(() => client.updateWorkflow('1', {}), (e: any) => {
    assert.equal(e.message, 'n8n PUT /api/v1/workflows/1 -> 403 nope');
    assert.equal(e.status, 403);
    return true;
  });
});

test('listWorkflows paginates via nextCursor', async () => {
  const { client, calls } = make((url) => url.includes('cursor=') ? { body: { data: [{ id: '2' }] } } : { body: { data: [{ id: '1' }], nextCursor: 'C 1' } });
  const wfs = await client.listWorkflows();
  assert.deepEqual(wfs.map((w) => w.id), ['1', '2']);
  assert.equal(calls[1][1], 'https://n8n.test/api/v1/workflows?cursor=C%201');
});

test('pagination uses & when projectId query present; non-array data tolerated', async () => {
  const { client, calls } = make((url) => url.includes('cursor=') ? { body: {} } : { body: { data: [{ id: '1' }], nextCursor: 'C1' } }, 'P/1');
  const wfs = await client.listWorkflows();
  assert.equal(wfs.length, 1);
  assert.equal(calls[0][1], 'https://n8n.test/api/v1/workflows?projectId=P%2F1');
  assert.equal(calls[1][1], 'https://n8n.test/api/v1/workflows?projectId=P%2F1&cursor=C1');
});

test('empty projectId is treated as unset', async () => {
  const { client, calls } = make(() => ({ body: { data: [] } }), '');
  await client.listWorkflows();
  assert.equal(calls[0][1], 'https://n8n.test/api/v1/workflows');
});

test('reqAll tolerates a null page', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => null }) as any;
  assert.deepEqual(await new TestClient('https://n8n.test', 'K', fetchImpl as any).listWorkflows(), []);
});

test('workflow verbs and paths', async () => {
  const { client, calls } = make(() => ({ body: { id: 'X' } }));
  await client.createWorkflow({ name: 'w' });
  await client.updateWorkflow('1', { a: 1 });
  await client.deleteWorkflow('1');
  await client.activateWorkflow('1');
  await client.deactivateWorkflow('1');
  await client.archiveWorkflow('1');
  await client.transferWorkflow('1', 'DEST');
  const b = 'https://n8n.test/api/v1/workflows';
  assert.deepEqual(calls, [
    ['POST', b, { name: 'w' }],
    ['PUT', `${b}/1`, { a: 1 }],
    ['DELETE', `${b}/1`, undefined],
    ['POST', `${b}/1/activate`, undefined],
    ['POST', `${b}/1/deactivate`, undefined],
    ['POST', `${b}/1/archive`, undefined],
    ['PUT', `${b}/1/transfer`, { destinationProjectId: 'DEST' }],
  ]);
});

test('a 204 No Content reply resolves to undefined instead of failing to parse an empty body', async () => {
  // n8n answers PUT /workflows/{id}/transfer with 204 and no body. A real fetch
  // Response rejects .json() on that, so req() must not call it.
  const fetchImpl = async () => new Response(null, { status: 204 });
  const client = new TestClient('https://n8n.test', 'K', fetchImpl as any);
  assert.equal(await client.transferWorkflow('1', 'DEST'), undefined);
});

test('credential verbs and paths', async () => {
  const { client, calls } = make(() => ({ body: { data: [] } }));
  await client.createCredential({ name: 'C' });
  await client.listCredentials();
  await client.getCredentialSchema('a/b');
  await client.updateCredential('9', { name: 'D' });
  await client.deleteCredential('9');
  const b = 'https://n8n.test/api/v1/credentials';
  assert.deepEqual(calls, [
    ['POST', b, { name: 'C' }],
    ['GET', b, undefined],
    ['GET', `${b}/schema/a%2Fb`, undefined],
    ['PATCH', `${b}/9`, { name: 'D' }],
    ['DELETE', `${b}/9`, undefined],
  ]);
});

test('transferCredential PUTs destinationProjectId and resolves on 204', async () => {
  const fetchImpl = async () => new Response(null, { status: 204 });
  const calls: any[] = [];
  const client = new TestClient('https://n8n.test', 'K', (async (u: string, init: any) => { calls.push([init.method, u, JSON.parse(init.body)]); return fetchImpl(); }) as any);
  assert.equal(await client.transferCredential('9', 'DEST'), undefined);
  assert.deepEqual(calls, [['PUT', 'https://n8n.test/api/v1/credentials/9/transfer', { destinationProjectId: 'DEST' }]]);
});

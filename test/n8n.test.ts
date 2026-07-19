import { test } from 'node:test';
import assert from 'node:assert/strict';
import { N8nClient } from '../src/n8n.ts';

function fakeFetch(calls: any[], response: any) {
  return async (url: string, init: any) => {
    calls.push({ url, init });
    return { ok: response.ok, status: response.status, text: async () => JSON.stringify(response.body), json: async () => response.body };
  };
}

test('listWorkflows unwraps .data and sends api key', async () => {
  const calls: any[] = [];
  const c = new N8nClient('https://n8n.test', 'KEY', fakeFetch(calls, { ok: true, status: 200, body: { data: [{ id: '1' }] } }) as any);
  const wfs = await c.listWorkflows();
  assert.deepEqual(wfs, [{ id: '1' }]);
  assert.equal(calls[0].url, 'https://n8n.test/api/v1/workflows');
  assert.equal(calls[0].init.headers['X-N8N-API-KEY'], 'KEY');
});

test('non-2xx throws with context', async () => {
  const c = new N8nClient('https://n8n.test', 'KEY', fakeFetch([], { ok: false, status: 400, body: { message: 'bad' } }) as any);
  await assert.rejects(() => c.updateWorkflow('1', {}), /n8n PUT .*400/);
});

test('listWorkflows follows nextCursor across pages', async () => {
  const urls: string[] = [];
  const fetchImpl = async (url: string) => {
    urls.push(url);
    const body = url.includes('cursor=') ? { data: [{ id: '2' }] } : { data: [{ id: '1' }], nextCursor: 'C1' };
    return { ok: true, status: 200, text: async () => '', json: async () => body } as any;
  };
  const c = new N8nClient('https://n8n.test', 'K', fetchImpl as any);
  const wfs = await c.listWorkflows();
  assert.deepEqual(wfs.map((w: any) => w.id), ['1', '2'], 'both pages collected');
  assert.equal(urls.length, 2);
  assert.match(urls[1], /cursor=C1/);
});

test('createWorkflow POSTs to /workflows', async () => {
  const calls: any[] = [];
  const c = new N8nClient('https://n8n.test', 'K', fakeFetch(calls, { ok: true, status: 200, body: { id: 'NEW' } }) as any);
  const r = await c.createWorkflow({ name: 'x' });
  assert.equal(r.id, 'NEW');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].url, 'https://n8n.test/api/v1/workflows');
});

test('n8nProjectId: listWorkflows filters, createCredential injects projectId, createWorkflow transfers', async () => {
  const calls: any[] = [];
  const fetchImpl = async (url: string, init: any) => { calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined }); return { ok: true, status: 200, text: async () => '', json: async () => ({ id: 'NEW', data: [] }) } as any; };
  const c = new N8nClient('https://n8n.test', 'K', fetchImpl as any, 'PROJ1');

  await c.listWorkflows();
  assert.match(calls[0].url, /\/workflows\?projectId=PROJ1/);

  calls.length = 0;
  await c.createCredential({ name: 'C', type: 't', data: {} });
  assert.equal(calls[0].url, 'https://n8n.test/api/v1/credentials');
  assert.equal(calls[0].body.projectId, 'PROJ1');

  calls.length = 0;
  await c.createWorkflow({ name: 'W' });
  assert.equal(calls[0].url, 'https://n8n.test/api/v1/workflows');           // create
  assert.equal(calls[1].url, 'https://n8n.test/api/v1/workflows/NEW/transfer'); // then transfer
  assert.equal(calls[1].body.destinationProjectId, 'PROJ1');
});

test('no n8nProjectId → no projectId anywhere (backward compatible)', async () => {
  const calls: any[] = [];
  const fetchImpl = async (url: string, init: any) => { calls.push({ url, body: init.body ? JSON.parse(init.body) : undefined }); return { ok: true, status: 200, text: async () => '', json: async () => ({ id: 'X', data: [] }) } as any; };
  const c = new N8nClient('https://n8n.test', 'K', fetchImpl as any); // no projectId
  await c.listWorkflows();
  assert.equal(calls[0].url, 'https://n8n.test/api/v1/workflows'); // no ?projectId
  calls.length = 0;
  await c.createWorkflow({ name: 'W' });
  assert.equal(calls.length, 1, 'no transfer call');
});

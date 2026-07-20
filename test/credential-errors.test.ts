import { test } from 'node:test';
import assert from 'node:assert/strict';
import { explainCredentialError } from '../src/entities/credential.ts';
import { MemoryStore } from '../src/store/memory.ts';
import { applyFromState } from '../src/engine/apply-state.ts';
import type { State } from '../src/engine/state.ts';

const shopify400 = 'n8n PATCH /api/v1/credentials/xaY3 -> 400 {"message":"request.body.data does not match allOf schema [subschema 0] with 2 error[s]:,request.body.data does not match allOf schema [subschema 0] with 1 error[s]:,request.body.data requires property \\"allowedDomains\\""}';
const mongo400 = 'n8n PATCH /api/v1/credentials/UVlZ -> 400 {"message":"request.body.data requires property \\"host\\",request.body.data requires property \\"user\\",request.body.data requires property \\"port\\""}';

test('explainCredentialError names the missing fields instead of dumping n8n allOf soup', () => {
  const msg = explainCredentialError('Shopify Admin', 'httpHeaderAuth', true, shopify400);
  assert.match(msg, /missing required field\(s\): allowedDomains\./);
  assert.ok(!msg.includes('subschema'), 'raw allOf noise is replaced');
});

test('explainCredentialError collects every missing field, deduped and in order', () => {
  const msg = explainCredentialError('MongoDB', 'mongoDb', true, mongo400);
  assert.match(msg, /missing required field\(s\): host, user, port\./);
});

test('explainCredentialError passes unrelated errors through untouched', () => {
  const msg = explainCredentialError('X', 'openAiApi', true, 'n8n PATCH ... -> 401 Unauthorized');
  assert.match(msg, /401 Unauthorized/);
  assert.ok(!msg.includes('missing required field'));
});

test('explainCredentialError does not blame `data` when none was sent', () => {
  const msg = explainCredentialError('X', 'httpHeaderAuth', false, shopify400);
  assert.ok(!msg.includes('missing required field'), 'no data sent → not a data-shape problem');
});

test('pull sets the credential live baseline, so an untouched credential plans as noop', async () => {
  // Without a baseline every credential looked "changed" after a pull, and apply
  // pushed `data` on all of them — which n8n rejects. A secret can't be read back,
  // so the pulled {name,type} is the only baseline plan can diff against.
  const { pullEntity } = await import('../src/engine/pull.ts');
  const { credential } = await import('../src/entities/credential.ts');
  const store = new MemoryStore();
  const ctx = {
    env: 'default', encrypted: false,
    n8n: { listCredentials: async () => [{ id: 'N1', name: 'Shopify Admin', type: 'httpHeaderAuth', updatedAt: 'T1' }] },
    getDefinitions: (k: string) => store.getDefinitions('default', k),
  } as any;
  const r = await pullEntity(store, credential, '/tmp', ctx);
  const live = await store.getLive('credentials');
  assert.equal(live.length, 1, 'pull established a live baseline');
  assert.deepEqual(live[0].checksum, r.docs[0].checksum, 'baseline matches what was pulled');
});

// An n8n that rejects `data` unless it carries allowedDomains — and, deliberately,
// exposes NO getCredentialSchema, so the recovery cannot depend on that endpoint.
function n8nRequiringAllowedDomains(calls: any[]) {
  return {
    updateCredential: async (id: string, body: any) => {
      calls.push(JSON.parse(JSON.stringify(body)));
      if (body.data && !('allowedDomains' in body.data)) {
        throw new Error(`n8n PATCH /api/v1/credentials/${id} -> 400 {"message":"request.body.data does not match allOf schema [subschema 0] with 2 error[s]:,request.body.data requires property \\"allowedDomains\\""}`);
      }
      return { updatedAt: 'T2' };
    },
  };
}

test('n8n rejecting `data` for a field with NO default → retry WITHOUT data (secret preserved, apply succeeds)', async () => {
  const { credential } = await import('../src/entities/credential.ts');
  const calls: any[] = [];
  const ctx = {
    env: 'default', encrypted: false,
    n8n: {
      updateCredential: async (id: string, body: any) => {
        calls.push(JSON.parse(JSON.stringify(body)));
        // `host` has no safe default — n8c cannot invent it
        if (body.data && !('host' in body.data)) throw new Error(`n8n PATCH /api/v1/credentials/${id} -> 400 {"message":"request.body.data requires property \\"host\\""}`);
        return { updatedAt: 'T2' };
      },
    },
    getDefinitions: async () => ({ c1: { id: 'N1', name: 'Mongo' } }),
  } as any;
  const docs = [{ localId: 'c1', name: 'Mongo', body: { name: 'Mongo', type: 'mongoDb', data: { connectionString: 'x' } } }];

  const mapping = await credential.pushToServer!(ctx, docs as any, { c1: 'changed' });
  assert.equal(calls.length, 2, 'tried with data, then retried without');
  assert.ok(calls[0].data, 'first attempt carried data');
  assert.equal(calls[1].data, undefined, 'retry omitted data');
  assert.equal(calls[1].isPartialData, true, 'isPartialData keeps the stored secret');
  assert.deepEqual(mapping.c1, { id: 'N1', name: 'Mongo', updatedAt: 'T2' }, 'credential still applied');
});

test('allowedDomains defaults to "*" when n8n asks for it and the file omits it', async () => {
  const { credential } = await import('../src/entities/credential.ts');
  const calls: any[] = [];
  const ctx = { env: 'default', encrypted: false, n8n: n8nRequiringAllowedDomains(calls), getDefinitions: async () => ({ c1: { id: 'N1', name: 'Qdrant' } }) } as any;
  const docs = [{ localId: 'c1', name: 'Qdrant', body: { name: 'Qdrant', type: 'httpHeaderAuth', data: { name: 'Authorization', value: 'tok' } } }];

  await credential.pushToServer!(ctx, docs as any, { c1: 'changed' });
  assert.equal(calls.length, 2, 'rejected, then retried with the default filled in');
  assert.deepEqual(calls[1].data, { name: 'Authorization', value: 'tok', allowedDomains: '*' }, 'secret IS set, with a permissive default');
});

test('an explicit allowedDomains is never overwritten by the default', async () => {
  const { credential } = await import('../src/entities/credential.ts');
  const calls: any[] = [];
  const ctx = { env: 'default', encrypted: false, n8n: n8nRequiringAllowedDomains(calls), getDefinitions: async () => ({ c1: { id: 'N1', name: 'Qdrant' } }) } as any;
  const docs = [{ localId: 'c1', name: 'Qdrant', body: { name: 'Qdrant', type: 'httpHeaderAuth', data: { name: 'Authorization', value: 'tok', allowedDomains: 'shopify.com' } } }];

  await credential.pushToServer!(ctx, docs as any, { c1: 'changed' });
  assert.equal(calls.length, 1, 'accepted first time — no retry');
  assert.equal(calls[0].data.allowedDomains, 'shopify.com', 'your value is kept');
});

test('the default is NOT injected into a type that has no such field (e.g. mongoDb)', async () => {
  // mongoDb rejects an unknown allowedDomains; blindly adding it would just trade
  // one 400 for another. Only fields n8n actually asked for get defaulted.
  const { credential } = await import('../src/entities/credential.ts');
  const calls: any[] = [];
  const ctx = {
    env: 'default', encrypted: false,
    n8n: {
      updateCredential: async (id: string, body: any) => {
        calls.push(JSON.parse(JSON.stringify(body)));
        if (body.data && 'allowedDomains' in body.data) throw new Error('400 {"message":"request.body.data is not allowed to have the additional property \\"allowedDomains\\""}');
        if (body.data && !('host' in body.data)) throw new Error('400 {"message":"request.body.data requires property \\"host\\""}');
        return { updatedAt: 'T2' };
      },
    },
    getDefinitions: async () => ({ c1: { id: 'N1', name: 'Mongo' } }),
  } as any;
  const docs = [{ localId: 'c1', name: 'Mongo', body: { name: 'Mongo', type: 'mongoDb', data: { connectionString: 'mongodb://x' } } }];

  await credential.pushToServer!(ctx, docs as any, { c1: 'changed' });
  for (const c of calls) assert.ok(!(c.data && 'allowedDomains' in c.data), 'never injected into mongoDb');
  assert.equal(calls[calls.length - 1].data, undefined, 'falls back to preserving the stored secret');
});

test('a COMPLETE `data` is pushed in one attempt', async () => {
  const { credential } = await import('../src/entities/credential.ts');
  const calls: any[] = [];
  const ctx = { env: 'default', encrypted: false, n8n: n8nRequiringAllowedDomains(calls), getDefinitions: async () => ({ c2: { id: 'N2', name: 'Full' } }) } as any;
  const docs = [{ localId: 'c2', name: 'Full', body: { name: 'Full', type: 'httpHeaderAuth', data: { name: 'Authorization', value: 'tok', allowedDomains: '' } } }];
  await credential.pushToServer!(ctx, docs as any, { c2: 'changed' });
  assert.equal(calls.length, 1, 'no retry needed');
  assert.deepEqual(calls[0].data, { name: 'Authorization', value: 'tok', allowedDomains: '' });
});

test('create: only-defaultable fields missing → filled in and the credential is created', async () => {
  const { credential } = await import('../src/entities/credential.ts');
  let sent: any;
  const ctx = {
    env: 'default', encrypted: false,
    n8n: { createCredential: async (b: any) => { if (!b.data?.allowedDomains) throw new Error('400 {"message":"request.body.data requires property \\"allowedDomains\\""}'); sent = b; return { id: 'NEW1' }; } },
    getDefinitions: async () => ({}),
  } as any;
  const mapping = await credential.pushToServer!(ctx, [{ localId: 'c1', name: 'Qdrant', body: { name: 'Qdrant', type: 'httpHeaderAuth', data: { value: 'tok' } } }] as any, { c1: 'new' });
  assert.deepEqual(sent.data, { value: 'tok', allowedDomains: '*' });
  assert.equal((mapping.c1 as any).id, 'NEW1');
});

test('create: fields with no default → a clear error (create needs COMPLETE data, unlike a PATCH)', async () => {
  const { credential } = await import('../src/entities/credential.ts');
  const raw = 'n8n POST /api/v1/credentials -> 400 {"message":"request.body.data requires property \\"headerName\\",request.body.data requires property \\"headerValue\\",request.body.data requires property \\"allowedDomains\\""}';
  const ctx = {
    env: 'default', encrypted: false,
    n8n: { createCredential: async () => { throw new Error(raw); } },
    getDefinitions: async () => ({}),
  } as any;
  await assert.rejects(
    () => credential.pushToServer!(ctx, [{ localId: 'c1', name: 'OpenAI account', body: { name: 'OpenAI account', type: 'openAiApi', data: { apiKey: 'sk-x' } } }] as any, { c1: 'new' }),
    (e: Error) => {
      assert.match(e.message, /must be CREATED on n8n/);
      assert.match(e.message, /requires headerName, headerValue, allowedDomains and gives no default/);
      assert.match(e.message, /create the credential in the n8n UI and run `n8c pull`/);
      assert.ok(!e.message.includes('credential "OpenAI account": credential'), 'not double-prefixed');
      return true;
    },
  );
});

test('collectFieldDefaults reads n8n\'s own defaults, including inherited allOf branches', async () => {
  const { collectFieldDefaults } = await import('../src/engine/types-gen.ts');
  const defaults = collectFieldDefaults({
    allOf: [
      { properties: { apiKey: { type: 'string', default: '' }, headerName: { type: 'string', default: 'Authorization' } } },
      { properties: { allowedDomains: { type: 'string', default: '' } } },
    ],
    properties: { url: { type: 'string', default: 'https://api.openai.com' }, noDefault: { type: 'string' } },
  });
  assert.equal(defaults.headerName, 'Authorization', 'inherited branch default found');
  assert.equal(defaults.allowedDomains, '');
  assert.equal(defaults.url, 'https://api.openai.com');
  assert.ok(!('noDefault' in defaults), 'fields without a default are not invented');
});

test('a rejected create is completed from n8n schema defaults (the OpenAI account case)', async () => {
  const { credential } = await import('../src/entities/credential.ts');
  let sent: any;
  const ctx = {
    env: 'default', encrypted: false,
    n8n: {
      getCredentialSchema: async () => ({ allOf: [
        { properties: { apiKey: { default: '' }, headerName: { default: 'Authorization' }, headerValue: { default: '' } } },
        { properties: { allowedDomains: { default: '' } } },
      ] }),
      createCredential: async (b: any) => {
        for (const f of ['headerName', 'headerValue', 'allowedDomains']) {
          if (!(f in b.data)) throw new Error(`400 {"message":"request.body.data requires property \\"${f}\\""}`);
        }
        sent = b; return { id: 'NEW1' };
      },
    },
    getDefinitions: async () => ({}),
  } as any;
  const mapping = await credential.pushToServer!(ctx, [{ localId: 'c1', name: 'OpenAI account', body: { name: 'OpenAI account', type: 'openAiApi', data: { apiKey: 'sk-x' } } }] as any, { c1: 'new' });
  assert.equal((mapping.c1 as any).id, 'NEW1', 'credential created');
  assert.equal(sent.data.apiKey, 'sk-x', 'your value is kept');
  assert.equal(sent.data.headerName, 'Authorization', 'filled from n8n\'s schema default');
  assert.ok('headerValue' in sent.data && 'allowedDomains' in sent.data);
});

test('fields n8n gives no default for are never invented (mongoDb host/user)', async () => {
  const { fillMissingFields } = await import('../src/entities/credential.ts');
  const ctx = { n8n: { getCredentialSchema: async () => ({ properties: { connectionString: { default: '' }, host: {}, user: {} } }) } } as any;
  assert.equal(await fillMissingFields(ctx, 'mongoDb', { connectionString: 'm' }, ['host', 'user']), null,
    'null → caller preserves the stored secret instead of guessing');
});

test('a non-schema error is NOT retried — it fails loudly', async () => {
  const { credential } = await import('../src/entities/credential.ts');
  const calls: any[] = [];
  const ctx = {
    env: 'default', encrypted: false,
    n8n: { updateCredential: async (_id: string, body: any) => { calls.push(body); throw new Error('n8n PATCH ... -> 401 Unauthorized'); } },
    getDefinitions: async () => ({ c3: { id: 'N3', name: 'X' } }),
  } as any;
  const docs = [{ localId: 'c3', name: 'X', body: { name: 'X', type: 'httpHeaderAuth', data: { k: 'v' } } }];
  await assert.rejects(() => credential.pushToServer!(ctx, docs as any, { c3: 'changed' }), /401/);
  assert.equal(calls.length, 1, 'no pointless retry');
});

test('deleting a credential that is already gone on n8n (404) succeeds — delete is idempotent', async () => {
  const store = new MemoryStore();
  await store.withTransaction((s) => store.putDefinitions('default', 'credentials', { c1: { id: 'GONE', name: 'OpenAI account' } }, s));
  await store.withTransaction((s) => store.putLive('credentials', [
    { localId: 'c1', name: 'OpenAI account', body: { name: 'OpenAI account', type: 'openAiApi' }, checksum: 'x' },
  ], s));
  const ctx = {
    env: 'default', encrypted: false, promptContentsEnabled: false,
    n8n: { listWorkflows: async () => [], deleteCredential: async () => { throw new Error('n8n DELETE /api/v1/credentials/GONE -> 404 {"message":"Not Found"}'); } },
    getDefinitions: (k: string) => store.getDefinitions('default', k),
  } as any;
  const state: State = {
    env: 'default', n8cVersion: '0', createdAt: '', desiredChecksum: '',
    summary: { create: 0, update: 0, noop: 0, delete: 1 },
    resources: [{ kind: 'credentials', localId: 'c1', name: 'OpenAI account', action: 'delete', fromChecksum: 'x', toChecksum: null }],
    applied: null,
  };
  const done = await applyFromState(store, '/tmp', ctx, state);
  assert.deepEqual(done.applied!.failed, [], 'a 404 on delete is not a failure');
  assert.deepEqual(done.applied!.ok, ['c1']);
  assert.deepEqual(await store.getLive('credentials'), [], 'live doc removed');
  assert.deepEqual(await store.getDefinitions('default', 'credentials'), {}, 'mapping removed');
});

test('a non-404 delete error still fails loudly', async () => {
  const store = new MemoryStore();
  await store.withTransaction((s) => store.putDefinitions('default', 'credentials', { c1: { id: 'X', name: 'C' } }, s));
  await store.withTransaction((s) => store.putLive('credentials', [{ localId: 'c1', name: 'C', body: {}, checksum: 'x' }], s));
  const ctx = {
    env: 'default', encrypted: false, promptContentsEnabled: false,
    n8n: { listWorkflows: async () => [], deleteCredential: async () => { throw new Error('n8n DELETE ... -> 403 Forbidden'); } },
    getDefinitions: (k: string) => store.getDefinitions('default', k),
  } as any;
  const state: State = {
    env: 'default', n8cVersion: '0', createdAt: '', desiredChecksum: '',
    summary: { create: 0, update: 0, noop: 0, delete: 1 },
    resources: [{ kind: 'credentials', localId: 'c1', name: 'C', action: 'delete', fromChecksum: 'x', toChecksum: null }],
    applied: null,
  };
  const done = await applyFromState(store, '/tmp', ctx, state);
  assert.equal(done.applied!.failed.length, 1, '403 is a real failure');
  assert.match(done.applied!.failed[0].error, /403/);
});

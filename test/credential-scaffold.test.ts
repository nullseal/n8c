import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createEntity } from '../src/engine/generate.ts';
import { CREDENTIAL_DATA_EXAMPLE } from '../src/engine/credential-examples.ts';

// n8n checks a credential's `data` against its type's schema and rejects any key
// the type doesn't define, so `n8c create credential` must scaffold the type's own
// field names. Returns the scaffolded source and what it evaluates to.
async function scaffold(name: string, type: string): Promise<{ src: string; body: any }> {
  const root = mkdtempSync(join(tmpdir(), 'n8c-'));
  try {
    const file = join(createEntity(root, 'credential', { name, nodeType: type }).dir, 'apply.ts');
    return { src: readFileSync(file, 'utf8'), body: (await import(pathToFileURL(file).href)).default };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('create credential scaffolds httpHeaderAuth with its own fields, name and value', async (t) => {
  process.env.API_TOKEN = 'tok-1';
  t.after(() => { delete process.env.API_TOKEN; });
  const { body } = await scaffold('API', 'httpHeaderAuth');
  assert.deepEqual(body.data, { name: 'Authorization', value: 'tok-1' });
});

test('create credential scaffolds every type n8c has an example for with exactly its fields', async () => {
  for (const [type, example] of Object.entries(CREDENTIAL_DATA_EXAMPLE)) {
    const { body } = await scaffold('Svc', type);
    assert.deepEqual(Object.keys(body.data), [...example.matchAll(/(\w+):/g)].map((m) => m[1]), type);
  }
});

test('create credential for a type n8c has no example for writes a TODO, not a guessed field', async () => {
  const { src, body } = await scaffold('Chat', 'slackApi');
  assert.deepEqual(body.data, {});
  assert.match(src, /TODO: add slackApi's fields/);
  assert.match(src, /n8c types/);
});

// A scaffold is live code: reading one of n8c's own variables would send n8c's
// own DB URL or API key to n8n as the credential's secret.
test('a scaffolded credential never reads an environment variable n8c itself uses', async () => {
  for (const type of Object.keys(CREDENTIAL_DATA_EXAMPLE)) {
    const { src } = await scaffold('Svc', type);
    assert.doesNotMatch(src, /process\.env\.(MONGO_URI|SQLITE_PATH|N8N_\w+|N8C_\w+)\b/, type);
  }
});

// n8n's mongoDb credential reads connectionString only when configurationType is
// 'connectionString'. The default, 'values', connects with host/user instead and
// silently ignores the string.
test('the mongoDb example selects the connection-string configuration', async () => {
  const { body } = await scaffold('Mongo', 'mongoDb');
  assert.equal(body.data.configurationType, 'connectionString');
});

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildContext } from '../src/context.ts';
import { N8nClientV2 } from '../src/n8n/v2.ts';
import { N8nClientV3 } from '../src/n8n/v3.ts';

let cwd: string;
let envSnapshot: NodeJS.ProcessEnv;

beforeEach(() => {
  envSnapshot = { ...process.env };
  cwd = mkdtempSync(join(tmpdir(), 'n8c-ctx-'));
  process.env.SQLITE_PATH = join(cwd, 't.sqlite');
  process.env.N8N_BASE = 'http://127.0.0.1:1';
  process.env.N8N_API_KEY = 'k';
});

afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in envSnapshot)) delete process.env[k];
  for (const [k, v] of Object.entries(envSnapshot)) if (process.env[k] !== v) process.env[k] = v;
  rmSync(cwd, { recursive: true, force: true });
});

function config(c: Record<string, unknown>) {
  writeFileSync(join(cwd, 'n8c.config.json'), JSON.stringify(c));
}

test('no n8nVersion in config -> v3 client', async () => {
  config({});
  const { ctx, store } = await buildContext(cwd, 'workflow');
  try { assert.ok(ctx.n8n instanceof N8nClientV3); } finally { await store.close?.(); }
});

test('n8nVersion "2" -> v2 client, not v3', async () => {
  config({ n8nVersion: '2' });
  const { ctx, store } = await buildContext(cwd, 'workflow');
  try {
    assert.ok(ctx.n8n instanceof N8nClientV2);
    assert.ok(!(ctx.n8n instanceof N8nClientV3));
  } finally { await store.close?.(); }
});

test('n8nVersion 3 (number) -> v3 client', async () => {
  config({ n8nVersion: 3 });
  const { ctx, store } = await buildContext(cwd, 'workflow');
  try { assert.ok(ctx.n8n instanceof N8nClientV3); } finally { await store.close?.(); }
});

test('n8nVersion "1" is a hard error', async () => {
  config({ n8nVersion: '1' });
  await assert.rejects(buildContext(cwd, 'workflow'), /unsupported n8nVersion "1" — n8c supports n8n 2 and 3/);
});

test('n8nVersion "1" errors even with no N8N_BASE set', async () => {
  delete process.env.N8N_BASE;
  config({ n8nVersion: '1' });
  await assert.rejects(buildContext(cwd, 'workflow'), /n8c supports n8n 2 and 3/);
});

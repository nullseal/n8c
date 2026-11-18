import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { syncBuiltinESMExports } from 'node:module';
import rlp from 'node:readline/promises';
import { chmodSync, mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fsMod from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { MongoClient } from 'mongodb';
import { buildProgram, renderPlanIgnored, renderPlanOrphans, renderGeneration, groupByGeneration, resolveGenerationRef } from '../src/cli.ts';
import { setStyle } from '../src/style.ts';
import { createStore } from '../src/store/factory.ts';
import { SqliteStore } from '../src/store/sqlite.ts';

// In-process CLI run: commander parse with a fresh program, cwd = temp project.
export async function runCli(args: string[]): Promise<void> {
  await buildProgram().parseAsync(['node', 'n8c', ...args]);
}

interface Call { method: string; url: string; body?: any }
type FailRule = string | ((c: Call, calls: Call[]) => boolean);
interface FakeOpts {
  workflows?: any[];
  credentials?: any[];
  schemas?: Record<string, any>;
  // 500 on calls matching a "METHOD /path" prefix, or a predicate (given the call
  // and every call so far, the current one included).
  fail?: FailRule[];
}

// Minimal stateful fake n8n on 127.0.0.1: records every call, serves
// workflows/credentials; PUT /workflows/:id replaces the stored workflow.
export function fakeN8n(opts: FakeOpts = {}) {
  const calls: Call[] = [];
  const workflows = opts.workflows ?? [];
  const credentials = opts.credentials ?? [];
  const fail: FailRule[] = opts.fail ?? [];
  let stamp = 0;
  const srv = createServer((req, res) => {
    let raw = ''; req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined;
      const url = req.url!; const method = req.method!;
      const call = { method, url, body };
      calls.push(call);
      res.setHeader('content-type', 'application/json');
      if (fail.some((f) => (typeof f === 'string' ? `${method} ${url}`.startsWith(f) : f(call, calls)))) { res.statusCode = 500; return res.end('{"message":"boom"}'); }
      if (method === 'GET' && url.startsWith('/api/v1/workflows')) return res.end(JSON.stringify({ data: workflows, nextCursor: null }));
      if (method === 'GET' && url.startsWith('/api/v1/credentials/schema/')) {
        const type = decodeURIComponent(url.split('/').pop()!);
        return res.end(JSON.stringify(opts.schemas?.[type] ?? { properties: {} }));
      }
      if (method === 'GET' && url.startsWith('/api/v1/credentials')) return res.end(JSON.stringify({ data: credentials, nextCursor: null }));
      if (method === 'POST' && url === '/api/v1/workflows') return res.end(JSON.stringify({ ...body, id: 'nw1' }));
      if (method === 'PUT' && url.startsWith('/api/v1/workflows/')) {
        const id = url.split('/').pop()!;
        const saved = { ...body, id, updatedAt: `2027-01-01T00:00:${String(++stamp).padStart(2, '0')}Z` };
        const i = workflows.findIndex((w) => w.id === id);
        if (i >= 0) workflows[i] = saved; else workflows.push(saved);
        return res.end(JSON.stringify(saved));
      }
      res.end(JSON.stringify({ id: 'x', data: [] }));
    });
  });
  return {
    srv, calls, workflows, credentials, fail,
    listen: () => new Promise<number>((r) => srv.listen(0, '127.0.0.1', () => r((srv.address() as any).port))),
    close: () => new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); }),
  };
}

const origCwd = process.cwd();
let envSnapshot: NodeJS.ProcessEnv;
let cwd: string;
let servers: ReturnType<typeof fakeN8n>[] = [];

beforeEach(() => {
  envSnapshot = { ...process.env };
  cwd = mkdtempSync(join(tmpdir(), 'n8c-cli-'));
  process.chdir(cwd);
  process.env.SQLITE_PATH = join(cwd, 't.sqlite');
  delete process.env.N8N_BASE; delete process.env.N8N_API_KEY; delete process.env.MONGO_URI;
});

afterEach(async () => {
  process.chdir(origCwd);
  for (const k of Object.keys(process.env)) if (!(k in envSnapshot)) delete process.env[k];
  for (const [k, v] of Object.entries(envSnapshot)) if (process.env[k] !== v) process.env[k] = v;
  for (const s of servers) await s.close();
  servers = [];
  rmSync(cwd, { recursive: true, force: true });
  process.exitCode = undefined;
});

async function withFake(opts: FakeOpts = {}) {
  const f = fakeN8n(opts);
  servers.push(f);
  const port = await f.listen();
  process.env.N8N_BASE = `http://127.0.0.1:${port}`;
  process.env.N8N_API_KEY = 'k';
  return f;
}

// Capture console.log / console.error output for one test.
function capture(t: any) {
  const out: string[] = []; const err: string[] = [];
  t.mock.method(console, 'log', (...a: any[]) => { out.push(a.join(' ')); });
  t.mock.method(console, 'error', (...a: any[]) => { err.push(a.join(' ')); });
  return { out, err, text: () => out.join('\n'), errText: () => err.join('\n') };
}

const WF = (id: string, name: string) => ({
  id, name, active: false, updatedAt: '2026-01-01T00:00:00Z', nodes: [{ id: 'n1', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} }],
  connections: {}, settings: { executionOrder: 'v1' },
});

async function openStore() {
  return createStore('sqlite', { SQLITE_PATH: join(cwd, 't.sqlite') } as any, {});
}

// Pull workflow W1 from a fake n8n into files + DB (generation 1).
async function seedPulled(t: any, opts: FakeOpts = {}) {
  const fake = await withFake({ workflows: [WF('W1', 'Main')], ...opts });
  const cap = capture(t);
  await runCli(['init']);
  await runCli(['pull', '-y']);
  return { fake, cap };
}

// pull assigns its own localId (uuid) to each server workflow — find the one dir.
function wfDir(): string {
  const root = join(cwd, 'n8c', 'workflows');
  const dirs = readdirSync(root);
  assert.equal(dirs.length, 1, 'exactly one workflow dir');
  return join(root, dirs[0]);
}
function wfMetaPath() { return join(wfDir(), 'metadata.json'); }
// metadata.json and apply.ts must agree on the workflow name (validate enforces it).
function renameWf(name: string) {
  const m = JSON.parse(readFileSync(wfMetaPath(), 'utf8')); m.name = name;
  writeFileSync(wfMetaPath(), JSON.stringify(m, null, 2) + '\n');
  const apply = join(wfDir(), 'apply.ts');
  const src = readFileSync(apply, 'utf8');
  const next = src.replace(/(export default[\s\S]*?\n {2}"name": )".*"/, `$1${JSON.stringify(name)}`);
  assert.notEqual(next, src, 'apply.ts name rewritten');
  writeFileSync(apply, next);
}

// ---------------------------------------------------------------- init

test('init scaffolds files and reconciles sqlite indexes', async (t) => {
  const cap = capture(t);
  await runCli(['init']);
  assert.match(cap.text(), /project scaffold:/);
  assert.match(cap.text(), /DB indexes reconciled: /);
  assert.ok(existsSync(join(cwd, 'n8c.config.json')));
  assert.ok(existsSync(join(cwd, 't.sqlite')), 'sqlite file created');
  assert.doesNotMatch(cap.text(), /replica set/);
  // second run: nothing new to scaffold
  cap.out.length = 0;
  await runCli(['init']);
  assert.match(cap.text(), /project already scaffolded/);
});

test('init --project-only skips DB', async (t) => {
  const cap = capture(t);
  await runCli(['init', '--project-only']);
  assert.match(cap.text(), /project scaffold:/);
  assert.doesNotMatch(cap.text(), /DB indexes/);
  assert.ok(!existsSync(join(cwd, 't.sqlite')), 'no DB touched');
});

test('init --db-only skips scaffold', async (t) => {
  const cap = capture(t);
  await runCli(['init', '--db-only']);
  assert.match(cap.text(), /DB indexes reconciled: /);
  assert.doesNotMatch(cap.text(), /project scaffold|already scaffolded/);
  assert.ok(!existsSync(join(cwd, 'n8c.config.json')), 'no scaffold written');
  assert.ok(existsSync(join(cwd, 't.sqlite')));
});

test('init --agents writes AGENTS.md marker section', async (t) => {
  const cap = capture(t);
  await runCli(['init', '--agents', '--project-only']);
  assert.match(cap.text(), /AGENTS\.md created/);
  const md = readFileSync(join(cwd, 'AGENTS.md'), 'utf8');
  assert.match(md, /n8c/);
  assert.match(md, /<!--/, 'marker-delimited section');
});

test('init --agents updates existing AGENTS.md', async (t) => {
  writeFileSync(join(cwd, 'AGENTS.md'), '# My repo\n\nhand-written notes\n');
  writeFileSync(join(cwd, 'n8c.config.json'), JSON.stringify({ database: 'sqlite', root: 'flows' }));
  const cap = capture(t);
  await runCli(['init', '--agents', '--project-only']);
  assert.match(cap.text(), /AGENTS\.md updated/);
  const md = readFileSync(join(cwd, 'AGENTS.md'), 'utf8');
  assert.match(md, /hand-written notes/, 'existing content kept');
  assert.match(md, /flows/, 'configured root rendered');
  // re-run is idempotent
  await runCli(['init', '--agents', '--project-only']);
  assert.equal(readFileSync(join(cwd, 'AGENTS.md'), 'utf8'), md);
});

test('init with database mongodb and no MONGO_URI prints skip', async (t) => {
  writeFileSync(join(cwd, 'n8c.config.json'), JSON.stringify({ database: 'mongodb' }));
  const cap = capture(t);
  await runCli(['init']);
  assert.match(cap.text(), /DB setup skipped \(no MONGO_URI configured yet\)/);
  assert.doesNotMatch(cap.text(), /DB indexes reconciled/);
});

// ---------------------------------------------------------------- plan / apply

test('plan writes a state file and prints summary', async (t) => {
  await withFake({ workflows: [] });
  const cap = capture(t);
  await runCli(['init', '--db-only']);
  const wfDir = join(cwd, 'n8c', 'workflows', 'local1');
  mkdirSync(wfDir, { recursive: true });
  writeFileSync(join(wfDir, 'metadata.json'), JSON.stringify({ name: 'Brand New' }));
  writeFileSync(join(wfDir, 'apply.ts'), 'export default { nodes: [], connections: {} };\n');
  await runCli(['plan']);
  assert.match(cap.text(), /\+ workflow {2}.*Brand New/);
  assert.match(cap.text(), /Plan: 1 to create, 0 to update, 0 to destroy\./);
  assert.match(cap.text(), /state written → /);
  const states = readdirSync(join(cwd, '.states'));
  assert.equal(states.length, 1);
  const st = JSON.parse(readFileSync(join(cwd, '.states', states[0]), 'utf8'));
  assert.equal(st.summary.create, 1);
});

test('plan reports orphans and renamed workflow fields; --destroy flag accepted', async (t) => {
  const { fake } = await seedPulled(t);
  renameWf('Main Renamed');
  const cap = capture(t);
  await runCli(['plan']);
  assert.match(cap.text(), /~ workflow {2}.*Main Renamed {2}\(name/);
  // a changed node is named after the changed fields
  const apply = join(wfDir(), 'apply.ts');
  writeFileSync(apply, readFileSync(apply, 'utf8').replace('"parameters": {}', '"parameters": { "x": 1 }'));
  cap.out.length = 0;
  await runCli(['plan']);
  assert.match(cap.text(), /Main Renamed {2}\(.*name.*Start\)|Main Renamed {2}\(.*Start/);
  assert.match(cap.text(), /Plan: 0 to create, 1 to update, 0 to destroy\./);
  // remove the dir → orphan
  rmSync(wfDir(), { recursive: true });
  cap.out.length = 0;
  await runCli(['plan']);
  assert.match(cap.text(), /no longer has a file/);
  cap.out.length = 0;
  await runCli(['plan', '--destroy']);
  // the server-only workflow W1 is the one delete
  assert.match(cap.text(), /Plan: 0 to create, 0 to update, 1 to destroy\./);
  assert.ok(fake.calls.some((c) => c.method === 'GET' && c.url.startsWith('/api/v1/workflows')));
});

test('plan warns when credential listing fails on n8n', async (t) => {
  const { fake, cap } = await seedPulled(t);
  fake.fail.push('GET /api/v1/credentials'); // e.g. an expired key / missing permission
  cap.out.length = 0;
  await runCli(['plan']);
  assert.match(cap.text(), /could not list credentials on n8n/);
  assert.match(cap.text(), /n8n said: .*500/);
  assert.match(cap.text(), /state written → /);
});

test('plan warns when only the server baseline snapshot failed', async (t) => {
  const { fake, cap } = await seedPulled(t);
  // fail only the FIRST workflows listing after this point (the baseline read);
  // the diff's own listing then succeeds
  const base = fake.calls.length;
  fake.fail.push((c, calls) => c.method === 'GET' && c.url.startsWith('/api/v1/workflows')
    && calls.slice(base).filter((x) => x.method === 'GET' && x.url.startsWith('/api/v1/workflows')).length === 1);
  cap.out.length = 0;
  await runCli(['plan']);
  assert.match(cap.text(), /no server baseline recorded for this plan/);
  assert.match(cap.text(), /re-run `n8c plan` to record one/);
  assert.doesNotMatch(cap.text(), /could not list credentials/);
});

test('apply pushes the plan and prints applied', async (t) => {
  const { fake } = await seedPulled(t);
  renameWf('Main Renamed');
  const cap = capture(t);
  await runCli(['plan']);
  fake.calls.length = 0;
  await runCli(['apply', '-m', 'rename it']);
  const put = fake.calls.find((c) => c.method === 'PUT' && c.url === '/api/v1/workflows/W1');
  assert.ok(put, 'workflow pushed to n8n');
  assert.equal(put!.body.name, 'Main Renamed');
  assert.match(cap.text(), /Apply complete: 1 applied, 0 failed\./);
  assert.equal(process.exitCode, undefined);
  // the generation carries the message
  cap.out.length = 0;
  await runCli(['list']);
  assert.match(cap.text(), /rename it/);
});

test('apply --force plans and applies in one step; failures set exitCode 1', async (t) => {
  const { fake } = await seedPulled(t, { fail: ['PUT /api/v1/workflows/W1'] });
  renameWf('Will Fail');
  const cap = capture(t);
  await runCli(['apply', '--force']);
  assert.ok(fake.calls.some((c) => c.method === 'PUT' && c.url === '/api/v1/workflows/W1'));
  assert.match(cap.errText(), /✗ workflow Will Fail — .*500/);
  assert.match(cap.text(), /Apply complete: 0 applied, 1 failed\./);
  assert.equal(process.exitCode, 1);
});

test('apply refuses when files changed since plan', async (t) => {
  await seedPulled(t);
  renameWf('First');
  await runCli(['plan']);
  renameWf('Second');
  await assert.rejects(runCli(['apply']), /files changed since plan/);
});

test('apply blocks when n8n drifted since the plan', async (t) => {
  const { fake, cap } = await seedPulled(t);
  renameWf('Local Edit');
  await runCli(['plan']);
  fake.workflows[0] = { ...fake.workflows[0], name: 'Edited On n8n', updatedAt: '2099-01-01T00:00:00Z' }; // UI edit after the plan
  fake.calls.length = 0;
  cap.out.length = 0;
  await runCli(['apply']);
  assert.equal(process.exitCode, 1);
  assert.match(cap.errText(), /n8n changed since this plan was made \(1\)/);
  assert.match(cap.errText(), /workflow Edited On n8n|workflow Local Edit \(W1\) was modified on n8n/);
  assert.match(cap.errText(), /run `n8c plan` again/);
  assert.ok(!fake.calls.some((c) => c.method === 'PUT'), 'nothing pushed');
});

test('apply blocks when the workflow disappeared from n8n', async (t) => {
  const { fake, cap } = await seedPulled(t);
  renameWf('Local Edit');
  await runCli(['plan']);
  fake.workflows.length = 0;
  await runCli(['apply']);
  assert.equal(process.exitCode, 1);
  assert.match(cap.errText(), /workflow Local Edit \(W1\) no longer exists on n8n/);
  assert.ok(!fake.calls.some((c) => c.method === 'PUT'), 'nothing pushed');
});

test('apply stops when n8n state cannot be verified; --no-verify applies anyway', async (t) => {
  const { fake, cap } = await seedPulled(t);
  renameWf('Local Edit');
  await runCli(['plan']);
  fake.fail.push('GET /api/v1/workflows');
  await runCli(['apply']);
  assert.equal(process.exitCode, 1);
  assert.match(cap.errText(), /cannot verify n8n state: n8n GET \/api\/v1\/workflows -> 500/);
  assert.match(cap.errText(), /re-run with --no-verify/);
  assert.ok(!fake.calls.some((c) => c.method === 'PUT'), 'nothing pushed');
  process.exitCode = undefined;
  // --no-verify skips the check: the push happens (post-apply refresh still fails → notice)
  fake.fail.length = 0;
  await runCli(['apply', '--no-verify']);
  assert.ok(fake.calls.some((c) => c.method === 'PUT' && c.url === '/api/v1/workflows/W1'));
  assert.equal(process.exitCode, undefined);
});

test('apply on a plan that predates state verification proceeds with a notice', async (t) => {
  const { fake, cap } = await seedPulled(t);
  renameWf('Local Edit');
  await runCli(['plan']);
  const dir = join(cwd, '.states');
  const file = join(dir, readdirSync(dir)[0]);
  const st = JSON.parse(readFileSync(file, 'utf8'));
  delete st.serverFacts; delete st.serverListed; // legacy state file
  writeFileSync(file, JSON.stringify(st));
  cap.out.length = 0;
  await runCli(['apply']);
  assert.match(cap.text(), /this plan predates state verification/);
  assert.ok(fake.calls.some((c) => c.method === 'PUT' && c.url === '/api/v1/workflows/W1'));
  assert.match(cap.text(), /Apply complete: 1 applied, 0 failed\./);
});

test('apply warns when the post-apply baseline cannot be refreshed', async (t) => {
  const { fake, cap } = await seedPulled(t);
  renameWf('Local Edit');
  await runCli(['plan']);
  // after the push, every workflows listing fails → the refresh yields no facts
  fake.fail.push((c, calls) => c.method === 'GET' && c.url.startsWith('/api/v1/workflows') && calls.some((x) => x.method === 'PUT'));
  cap.out.length = 0;
  await runCli(['apply']);
  assert.match(cap.text(), /could not refresh the post-apply baseline/);
  const dir = join(cwd, '.states');
  const st = JSON.parse(readFileSync(join(dir, readdirSync(dir)[0]), 'utf8'));
  assert.equal(st.serverListed, false, 'state records that no baseline exists');
  assert.equal(st.serverFacts, undefined);
});

// ---------------------------------------------------------------- pull

test('pull imports server workflows into files and DB', async (t) => {
  // an agent node (→ extracted prompt) and a credential, so every kind is exported
  const wf = WF('W1', 'Main');
  wf.nodes.push({ id: 'n2', name: 'Agent', type: '@n8n/n8n-nodes-langchain.agent', typeVersion: 1, position: [200, 0], parameters: { options: { systemMessage: 'You are helpful.' } } } as any);
  const fake = await withFake({ workflows: [wf], credentials: [{ id: 'c1', name: 'Hdr', type: 'httpHeaderAuth', updatedAt: '2026-01-01T00:00:00Z' }] });
  const cap = capture(t);
  await runCli(['init']);
  await runCli(['pull']);
  assert.ok(existsSync(wfMetaPath()), 'workflow dir written');
  assert.equal(JSON.parse(readFileSync(wfMetaPath(), 'utf8')).name, 'Main');
  assert.equal(readdirSync(join(cwd, 'n8c', 'credentials')).length, 1, 'credential exported');
  assert.equal(readdirSync(join(cwd, 'n8c', 'prompts')).length, 1, 'prompt extracted');
  assert.ok(existsSync(join(cwd, 'n8c', 'n8c.types.ts')), 'types regenerated');
  assert.match(cap.text(), /pulled workflow 1 — [0-9a-f]{8} — changed/);
  assert.match(cap.text(), /pulled credential 1 — /);
  assert.match(cap.text(), /pulled prompt 1 — /);
  assert.match(cap.text(), /✓ generation [0-9a-f]{8} created/);
  assert.match(cap.text(), /↳ exported workflow to files/);
  assert.match(cap.text(), /↳ types regenerated/);
  assert.match(cap.text(), /↳ mapped 1 credential\(s\) from workflows|↳ mapped \d+ credential/);
  assert.ok(fake.calls.some((c) => c.method === 'GET' && c.url.startsWith('/api/v1/workflows')));
  const store = await openStore();
  try {
    assert.deepEqual((await store.getLive('workflows')).map((d) => d.name), ['Main']);
    assert.deepEqual((await store.getLive('credentials')).map((d) => d.name), ['Hdr']);
    assert.equal((await store.getLive('prompts')).length, 1);
    assert.equal((await store.listVersions('workflows')).length, 1);
  } finally { await store.close(); }
  // pulling again with nothing changed creates no second generation
  cap.out.length = 0;
  await runCli(['pull', '-y']);
  assert.match(cap.text(), /= nothing changed — no new generation/);
  assert.match(cap.text(), /pulled workflow 1 — [0-9a-f]{8} — no changes/);
  const again = await openStore();
  try { assert.equal((await again.listVersions('workflows')).length, 1); } finally { await again.close(); }
});

test('types creates the n8c root when the project has none', async (t) => {
  await withFake();
  const cap = capture(t);
  await runCli(['init', '--db-only']);
  assert.ok(!existsSync(join(cwd, 'n8c')), 'fresh project has no root');
  await runCli(['types']);
  assert.ok(existsSync(join(cwd, 'n8c', 'n8c.types.ts')));
  assert.match(cap.text(), /types written → /);
});

test('the first pull into a fresh project writes n8c.types.ts', async (t) => {
  await withFake({ workflows: [WF('W1', 'Main')] });
  const cap = capture(t);
  await runCli(['init', '--db-only']);
  assert.ok(!existsSync(join(cwd, 'n8c')), 'fresh project has no root');
  await runCli(['pull']);
  assert.ok(existsSync(join(cwd, 'n8c', 'n8c.types.ts')), 'types file written');
  assert.doesNotMatch(cap.errText() + cap.text(), /types skipped/);
  assert.match(cap.text(), /↳ types regenerated/);
});

async function generationCount(): Promise<number> {
  const store = await openStore();
  try {
    const perKind = [];
    for (const kind of ['workflows', 'prompts', 'credentials']) perKind.push({ kind, versions: await store.listVersions(kind) });
    return groupByGeneration(perKind).length;
  } finally { await store.close(); }
}

test('a pull with always-empty credentials and prompts creates no generation the second time', async (t) => {
  await withFake({ workflows: [WF('W1', 'Main')] });
  const cap = capture(t);
  await runCli(['init', '--db-only']);
  await runCli(['pull']);
  assert.equal(await generationCount(), 1);
  cap.out.length = 0;
  await runCli(['pull', '-y']);
  assert.match(cap.text(), /= nothing changed — no new generation/);
  assert.equal(await generationCount(), 1, 'generations unchanged');
});

test('a kind that became empty is one change, then pulls report nothing changed', async (t) => {
  const fake = await withFake({ workflows: [WF('W1', 'Main')], credentials: [{ id: 'c1', name: 'Hdr', type: 'httpHeaderAuth', updatedAt: '2026-01-01T00:00:00Z' }] });
  const cap = capture(t);
  await runCli(['init', '--db-only']);
  await runCli(['pull']);
  assert.equal(await generationCount(), 1);
  fake.credentials.length = 0;
  cap.out.length = 0;
  await runCli(['pull', '-y']);
  assert.match(cap.text(), /pulled credential 0 — [0-9a-f]{8} — changed/);
  assert.match(cap.text(), /✓ generation [0-9a-f]{8} created/);
  assert.equal(await generationCount(), 2, 'exactly one new generation');
  cap.out.length = 0;
  await runCli(['pull', '-y']);
  assert.match(cap.text(), /= nothing changed — no new generation/);
  assert.equal(await generationCount(), 2, 'no further generation');
});

test('pull --no-export fills the DB only', async (t) => {
  await withFake({ workflows: [WF('W1', 'Main')] });
  const cap = capture(t);
  await runCli(['init', '--db-only']);
  await runCli(['pull', '--no-export', '-m', 'db only']);
  assert.ok(!existsSync(join(cwd, 'n8c', 'workflows')), 'no files written');
  assert.doesNotMatch(cap.text(), /exported/);
  const store = await openStore();
  try {
    assert.equal((await store.getLive('workflows')).length, 1);
  } finally { await store.close(); }
});

test('pull warns about hardcoded secrets in exported workflows', async (t) => {
  const wf = WF('W1', 'Leaky');
  (wf.nodes[0] as any).parameters = { headers: { Authorization: 'Bearer sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD' } };
  await withFake({ workflows: [wf] });
  const cap = capture(t);
  await runCli(['init', '--db-only']);
  await runCli(['pull']);
  assert.match(cap.errText(), /possible hardcoded secret\(s\) in exported files/);
  assert.match(cap.errText(), /^ {4}- /m);
});

test('pull reports a types failure without aborting', async (t) => {
  await withFake({ workflows: [WF('W1', 'Main')] });
  const cap = capture(t);
  await runCli(['init', '--db-only']);
  mkdirSync(join(cwd, 'n8c'), { recursive: true });
  // a directory where n8c.types.ts must be written makes the write fail
  mkdirSync(join(cwd, 'n8c', 'n8c.types.ts'));
  await runCli(['pull']);
  assert.match(cap.errText(), /⚠ types skipped: /);
  assert.ok(existsSync(wfMetaPath()), 'export still happened');
});

test('pull reports a per-kind export failure without aborting', { skip: process.getuid?.() === 0 && 'root ignores directory permissions' }, async (t) => {
  await withFake({ workflows: [WF('W1', 'Main')] });
  const cap = capture(t);
  await runCli(['init', '--db-only']);
  // an empty but read-only workflows dir: the pull reads it fine, the export cannot write into it
  const wfRoot = join(cwd, 'n8c', 'workflows');
  mkdirSync(wfRoot, { recursive: true });
  chmodSync(wfRoot, 0o555);
  try {
    await runCli(['pull']);
  } finally { chmodSync(wfRoot, 0o755); }
  assert.match(cap.errText(), /⚠ export skipped for workflow: /);
  assert.match(cap.text(), /✓ generation/, 'the pull itself still committed');
  assert.deepEqual(readdirSync(wfRoot), [], 'nothing written');
});

test('pull refuses to overwrite a dirty root without --force', async (t) => {
  await withFake({ workflows: [WF('W1', 'Main')] });
  capture(t);
  await runCli(['init', '--db-only']);
  const dir = join(cwd, 'n8c', 'workflows', 'local');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'metadata.json'), '{"name":"mine"}');
  // stdout is not a TTY here; stdin may be one when run by hand — force non-TTY
  const wasTTY = process.stdin.isTTY; (process.stdin as any).isTTY = false;
  try {
    await assert.rejects(runCli(['pull']), /-y\/--yes/);
  } finally { (process.stdin as any).isTTY = wasTTY; }
  assert.ok(existsSync(join(dir, 'metadata.json')), 'local edits untouched');
});

for (const [answer, proceeds] of [['y', true], ['N', false]] as const) {
  test(`pull confirmation on a TTY: answer "${answer}" ${proceeds ? 'proceeds' : 'aborts'}`, async (t) => {
    await withFake({ workflows: [WF('W1', 'Main')] });
    const cap = capture(t);
    await runCli(['init', '--db-only']);
    const dir = join(cwd, 'n8c', 'workflows', 'local');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'metadata.json'), '{"name":"mine"}');
    const wasTTY = process.stdin.isTTY; (process.stdin as any).isTTY = true;
    let asked = ''; let closed = false;
    t.mock.method(rlp, 'createInterface', () => ({ question: async (q: string) => { asked = q; return answer; }, close() { closed = true; } }));
    syncBuiltinESMExports();
    try {
      await runCli(['pull']);
    } finally {
      t.mock.restoreAll(); syncBuiltinESMExports(); (process.stdin as any).isTTY = wasTTY;
    }
    assert.match(asked, /Continue\?/);
    assert.ok(closed, 'readline closed');
    assert.match(cap.text(), /overwrites the n8c root/);
    if (proceeds) {
      assert.ok(existsSync(wfMetaPath()), 'server workflow written');
      assert.ok(!existsSync(dir), 'stale local dir pruned');
    } else {
      assert.match(cap.text(), /pull aborted — nothing changed\./);
      assert.ok(existsSync(join(dir, 'metadata.json')), 'files untouched');
      assert.deepEqual(readdirSync(join(cwd, 'n8c', 'workflows')), ['local'], 'nothing pulled to files');
    }
  });
}

// ---------------------------------------------------------------- list / types / db

test('list prints generations', async (t) => {
  const { cap } = await seedPulled(t);
  cap.out.length = 0;
  await runCli(['list']);
  assert.match(cap.text(), /^\* [0-9a-f]{8}/m, 'active generation starred');
  assert.match(cap.text(), /workflow [0-9a-f]{8}/);
  cap.out.length = 0;
  await runCli(['list', '--full']);
  assert.match(cap.text(), /^\* [0-9a-f]{64}/m, 'full hash untruncated');
});

test('types writes n8c.types.ts and tsconfig', async (t) => {
  const fake = await withFake({
    credentials: [{ id: 'c1', name: 'Hdr', type: 'httpHeaderAuth' }],
    schemas: { httpHeaderAuth: { properties: { name: { type: 'string' }, value: { type: 'string' } }, required: ['name', 'value'] } },
  });
  const cap = capture(t);
  await runCli(['init', '--db-only']);
  await runCli(['types']);
  const file = join(cwd, 'n8c', 'n8c.types.ts');
  assert.match(cap.text(), /types written → .*n8c\.types\.ts/);
  assert.ok(existsSync(file));
  assert.match(readFileSync(file, 'utf8'), /httpHeaderAuth/);
  assert.ok(fake.calls.some((c) => c.url === '/api/v1/credentials/schema/httpHeaderAuth'), 'schema fetched');
  assert.ok(existsSync(join(cwd, 'tsconfig.json')));
  // an existing tsconfig is left alone, and a project with @types/node skips the ambient shim
  writeFileSync(join(cwd, 'tsconfig.json'), '{"custom":true}');
  mkdirSync(join(cwd, 'node_modules', '@types', 'node'), { recursive: true });
  await runCli(['types']);
  assert.equal(readFileSync(join(cwd, 'tsconfig.json'), 'utf8'), '{"custom":true}');
});

test('types tolerates an n8n that cannot list credentials', async (t) => {
  await withFake({ fail: ['GET /api/v1/credentials'] });
  const cap = capture(t);
  await runCli(['init', '--db-only']);
  await runCli(['types']);
  assert.match(cap.text(), /types written → /);
  assert.ok(existsSync(join(cwd, 'n8c', 'n8c.types.ts')));
});

test('db export/import on sqlite fail with the clear mongodb-only error', async (t) => {
  await seedPulled(t);
  await assert.rejects(runCli(['db', 'export', '-o', 'bk.json']), /backup is only supported for the mongodb store/);
  assert.ok(!existsSync(join(cwd, 'bk.json')), 'no file written');
  writeFileSync(join(cwd, 'bk.json'), '{}'); // import reads the file before touching the DB
  await assert.rejects(runCli(['db', 'import', 'bk.json']), /backup is only supported for the mongodb store/);
});

// sqlite has no backup capability, so give it a BackupDb port through the prototype
// to exercise the command's own file/IO/printing logic.
function stubBackupDb(t: any, cols: Map<string, { docs: any[]; indexes: any[] }>) {
  const db = {
    names: () => [...cols.keys()],
    find: async (n: string) => cols.get(n)!.docs.slice(),
    listIndexes: async (n: string) => cols.get(n)!.indexes.slice(),
    recreate: async (n: string) => { cols.set(n, { docs: [], indexes: [] }); },
    insert: async (n: string, docs: any[]) => { cols.get(n)!.docs.push(...docs); },
    createIndex: async (n: string, idx: any) => { cols.get(n)!.indexes.push(idx); },
  };
  t.mock.method(SqliteStore.prototype, 'backupDb', () => db);
}

test('db export writes a backup file / db import restores it', async (t) => {
  await seedPulled(t);
  const cols = new Map([
    ['n8c_workflows', { docs: [{ _id: 1, localId: 'w' }, { _id: 2, localId: 'x' }], indexes: [{ name: 'live', key: { localId: 1 } }] }],
    ['n8c_prompts', { docs: [{ _id: 3, localId: 'p' }], indexes: [] }],
  ]);
  stubBackupDb(t, cols);
  const cap = capture(t);
  await runCli(['db', 'export', '-o', 'bk.json']);
  assert.match(cap.text(), /backed up 2 collections, 3 record\(s\) → bk\.json/);
  const backup = JSON.parse(readFileSync(join(cwd, 'bk.json'), 'utf8'));
  assert.equal(backup.format, 'n8c-backup/1');
  assert.equal(backup.collections.n8c_workflows.docs.length, 2);
  assert.equal(backup.collections.n8c_workflows.indexes[0].name, 'live');

  // wipe the target, then import the backup back
  cols.clear();
  cols.set('n8c_workflows', { docs: [{ _id: 99 }], indexes: [] });
  cap.out.length = 0;
  await runCli(['db', 'import', 'bk.json']);
  assert.match(cap.text(), /restored 2 collections, 3 record\(s\), 1 index\(es\)/);
  assert.deepEqual(cols.get('n8c_workflows')!.docs.map((d) => d.localId), ['w', 'x'], 'existing records replaced by the backup');
  assert.equal(cols.get('n8c_prompts')!.docs.length, 1);
});

test('db export defaults to db.n8c-backup, import reads it back; bare `db` prints help', async (t) => {
  await seedPulled(t);
  const cols = new Map([['n8c_workflows', { docs: [{ _id: 1 }], indexes: [] }]]);
  stubBackupDb(t, cols);
  const cap = capture(t);
  await runCli(['db', 'export']);
  assert.ok(existsSync(join(cwd, 'db.n8c-backup')), 'default output file');
  cap.out.length = 0;
  await runCli(['db', 'import']);
  assert.match(cap.text(), /restored 1 collections, 1 record\(s\), 0 index\(es\)/);
  // `db` alone → help (commander exits through process.exit)
  const exits: any[] = [];
  t.mock.method(process, 'exit', (c?: number) => { exits.push(c); throw new Error('exit'); });
  const stdout = t.mock.method(process.stdout, 'write', () => true);
  await assert.rejects(runCli(['db']), /exit/);
  assert.match(stdout.mock.calls.map((c: any) => String(c.arguments[0])).join(''), /export/);
  assert.equal(exits[0], 0);
});

// ---------------------------------------------------------------- create

test('create workflow scaffolds an entity dir', async (t) => {
  const cap = capture(t);
  await runCli(['create', 'workflow', '--name', 'Greeter', '--description', 'says hi']);
  const dirs = readdirSync(join(cwd, 'n8c', 'workflows'));
  assert.equal(dirs.length, 1);
  assert.match(cap.text(), new RegExp(`created workflow ${dirs[0]}`));
  const meta = JSON.parse(readFileSync(join(cwd, 'n8c', 'workflows', dirs[0], 'metadata.json'), 'utf8'));
  assert.deepEqual(meta, { name: 'Greeter', description: 'says hi' });
  assert.ok(existsSync(join(cwd, 'n8c', 'workflows', dirs[0], 'apply.ts')));
});

test('create honours config root and rejects unknown types', async (t) => {
  capture(t);
  writeFileSync(join(cwd, 'n8c.config.json'), JSON.stringify({ root: 'flows' }));
  await runCli(['create', 'prompt', '--key', 'greet']);
  assert.equal(readdirSync(join(cwd, 'flows', 'prompts')).length, 1);
  await assert.rejects(runCli(['create', 'bogus']), /unknown create type bogus/);
});

test('create node prompts for the workflowId on a TTY', async (t) => {
  const cap = capture(t);
  const wasTTY = process.stdin.isTTY; (process.stdin as any).isTTY = true;
  let asked = ''; let closed = false;
  t.mock.method(rlp, 'createInterface', () => ({ question: async (q: string) => { asked = q; return '  wf9  '; }, close() { closed = true; } }));
  syncBuiltinESMExports();
  try {
    await runCli(['create', 'node', '--name', 'LLM', '--type', 'lmChatOpenAi']);
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports(); (process.stdin as any).isTTY = wasTTY;
  }
  assert.match(asked, /workflowId/);
  assert.ok(closed);
  const nodes = readdirSync(join(cwd, 'n8c', 'workflows', 'wf9', 'nodes'));
  assert.equal(nodes.length, 1);
  assert.match(cap.text(), /created node /);
});

// ---------------------------------------------------------------- restore / drop

// Two generations: pull (gen A: "Main"), then rename + plan + apply (gen B: "Renamed").
async function twoGenerations(t: any) {
  const { fake, cap } = await seedPulled(t);
  renameWf('Renamed');
  await runCli(['plan']);
  await runCli(['apply', '-m', 'second']);
  const store = await openStore();
  try {
    const gens = (await store.listVersions('workflows')).map((v: any) => v.versionId).sort();
    assert.equal(gens.length, 2);
    return { fake, cap, first: gens[0], second: gens[1] };
  } finally { await store.close(); }
}

test('restore <generation> restores live docs', async (t) => {
  const { cap, first } = await twoGenerations(t);
  assert.equal(JSON.parse(readFileSync(wfMetaPath(), 'utf8')).name, 'Renamed');
  cap.out.length = 0;
  await runCli(['restore', first]);
  assert.equal(JSON.parse(readFileSync(wfMetaPath(), 'utf8')).name, 'Main', 'file content back to generation 1');
  assert.match(cap.text(), /restored workflow → files\./);
  assert.match(cap.text(), new RegExp(`\\(${first.replace(/[.+]/g, '\\$&')}\\) restored\\.`));
  assert.match(cap.text(), /Run `n8c plan` to preview/);
});

test('restore --apply rolls back and deploys in one shot', async (t) => {
  const { fake, cap, first } = await twoGenerations(t);
  fake.calls.length = 0;
  cap.out.length = 0;
  await runCli(['restore', first, '--apply']);
  const put = fake.calls.find((c) => c.method === 'PUT' && c.url === '/api/v1/workflows/W1');
  assert.ok(put, 'rollback pushed to n8n');
  assert.equal(put!.body.name, 'Main');
  assert.match(cap.text(), /Apply complete: 1 applied, 0 failed\./);
  assert.equal(JSON.parse(readFileSync(wfMetaPath(), 'utf8')).name, 'Main');
});

test('restore rejects an unknown generation', async (t) => {
  await seedPulled(t);
  await assert.rejects(runCli(['restore', 'zzzz']), /no generation matching "zzzz"/);
});

test('drop <generation> deletes a version', async (t) => {
  const { cap, first, second } = await twoGenerations(t);
  cap.out.length = 0;
  await runCli(['drop', first]);
  assert.match(cap.text(), /dropped generation [0-9a-f]{8} /);
  assert.match(cap.text(), /1 generation\(s\) dropped/);
  const store = await openStore();
  try {
    const left = (await store.listVersions('workflows')).map((v: any) => v.versionId);
    assert.deepEqual(left, [second]);
  } finally { await store.close(); }
});

test('drop refuses the active generation', async (t) => {
  const { second } = await twoGenerations(t);
  await assert.rejects(runCli(['drop', second]), /cannot drop the active generation/);
  const store = await openStore();
  try {
    assert.equal((await store.listVersions('workflows')).length, 2, 'nothing dropped');
  } finally { await store.close(); }
});

// ---------------------------------------------------------------- misc

test('unknown command sets exitCode 1', async (t) => {
  const cap = capture(t);
  const w = t.mock.method(process.stdout, 'write', () => true);
  await runCli(['nope']);
  assert.equal(process.exitCode, 1);
  assert.match(cap.errText(), /unknown command 'nope'/);
  assert.match(w.mock.calls.map((c) => String(c.arguments[0])).join(''), /Usage: n8c/);
});

// ================================================================ branch sweep

const CLI_SRC = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

// ---- pure renderers: plural wording and unknown-kind fallbacks
test('renderPlanIgnored: plural wording and unknown kinds fall back to the raw kind', () => {
  setStyle(false);
  const out = renderPlanIgnored([{ kind: 'weird', localId: 'a', name: 'A' }, { kind: 'workflows', localId: 'b', name: 'B' }]);
  assert.match(out, /! 2 archived workflows are skipped/);
  assert.match(out, /^ {4}weird {2}\[a\] {2}A$/m, 'unmapped kind printed as-is');
  assert.match(out, /^ {4}workflow {2}\[b\] {2}B$/m);
  assert.match(out, /unarchive them in n8n/);
});

test('renderPlanOrphans: plural wording and unknown kinds fall back to the raw kind', () => {
  setStyle(false);
  const out = renderPlanOrphans([{ kind: 'weird', name: 'A' }, { kind: 'credentials', name: 'B' }]);
  assert.match(out, /! 2 entities exist on n8n\/in the DB but no longer have files:/);
  assert.match(out, /^ {4}weird {2}A$/m, 'unmapped kind printed as-is');
  assert.match(out, /^ {4}credential {2}B$/m);
  assert.match(out, /plan their removal/);
});

test('renderGeneration: unmapped kinds sort and print by raw name; mapped kinds by singular', () => {
  setStyle(false);
  const g = { versionId: 'V', hash: 'h'.repeat(64), kinds: [], active: false, members: [
    { kind: 'zeta', checksum: 'z'.repeat(64) }, { kind: 'workflows', checksum: 'w'.repeat(64) }, { kind: 'alpha', checksum: 'a'.repeat(64) },
  ] };
  const row = renderGeneration(g, false).split('\n')[1];
  assert.equal(row.trim(), 'alpha aaaaaaaa · workflow wwwwwwww · zeta zzzzzzzz');
});

test('groupByGeneration sorts newest-first for any input order', () => {
  const v = (versionId: string) => ({ versionId, isActive: false, checksum: 'c' });
  for (const order of [['A', 'B', 'C'], ['C', 'B', 'A'], ['B', 'C', 'A'], ['A', 'C', 'B']]) {
    const gens = groupByGeneration([{ kind: 'workflows', versions: order.map(v) }]);
    assert.deepEqual(gens.map((g) => g.versionId), ['C', 'B', 'A'], order.join());
  }
});

test('resolveGenerationRef: an ambiguous prefix lists each match, with its message when it has one', () => {
  const gens = [
    { versionId: 'V1', hash: 'abcd1111', kinds: [], members: [], active: false, message: 'first release' },
    { versionId: 'V2', hash: 'abcd2222', kinds: [], members: [], active: false },
  ];
  assert.throws(() => resolveGenerationRef(gens, 'abcd'), (e: any) => {
    assert.match(e.message, /ambiguous generation hash "abcd" \(2 matches\)/);
    assert.match(e.message, /abcd1111 {2}V1 {2}first release/);
    assert.match(e.message, /abcd2222 {2}V2\n/);
    return true;
  });
});

// ---- plan/apply summary sections
test('plan lists an archived workflow whose file differs as skipped', async (t) => {
  const wf = { ...WF('W1', 'Main'), isArchived: true };
  await withFake({ workflows: [wf] });
  const cap = capture(t);
  await runCli(['init']);
  await runCli(['pull', '-y']);
  renameWf('Main Edited');
  cap.out.length = 0;
  await runCli(['plan']);
  assert.match(cap.text(), /Plan: 0 to create, 0 to update, 0 to destroy\./);
  assert.match(cap.text(), /! 1 archived workflow is skipped — n8n rejects updates to archived workflows:/);
  assert.match(cap.text(), /workflow {2}\[[^\]]+\] {2}Main Edited/);
  assert.match(cap.text(), /unarchive it in n8n to let the change apply\./);
});

test('apply on a legacy saved plan without orphans/ignored prints just the summary line', async (t) => {
  const { fake, cap } = await seedPulled(t);
  renameWf('Local Edit');
  await runCli(['plan']);
  const dir = join(cwd, '.states');
  const file = join(dir, readdirSync(dir)[0]);
  const st = JSON.parse(readFileSync(file, 'utf8'));
  delete st.orphans; delete st.ignored;
  writeFileSync(file, JSON.stringify(st));
  cap.out.length = 0;
  await runCli(['apply']);
  assert.match(cap.text(), /Plan: 0 to create, 1 to update, 0 to destroy\./);
  assert.doesNotMatch(cap.text(), /no longer has a file|archived/);
  assert.ok(fake.calls.some((c) => c.method === 'PUT' && c.url === '/api/v1/workflows/W1'));
  assert.match(cap.text(), /Apply complete: 1 applied, 0 failed\./);
});

// ---- style switch (preAction hook)
test('color is on for a TTY stdout and off for --pipe or NO_COLOR', async (t) => {
  await seedPulled(t);
  const cap = capture(t);
  const wasTTY = process.stdout.isTTY; const wasArgv = process.argv;
  (process.stdout as any).isTTY = true;
  try {
    delete process.env.NO_COLOR;
    process.argv = ['node', 'n8c', 'list'];
    await runCli(['list']);
    assert.ok(cap.text().includes('\x1b['), 'TTY, no flag → styled');
    cap.out.length = 0;
    process.argv = ['node', 'n8c', 'list', '--pipe'];
    await runCli(['list']);
    assert.ok(!cap.text().includes('\x1b['), '--pipe → raw');
    cap.out.length = 0;
    process.argv = ['node', 'n8c', 'list']; process.env.NO_COLOR = '1';
    await runCli(['list']);
    assert.ok(!cap.text().includes('\x1b['), 'NO_COLOR → raw');
  } finally {
    process.argv = wasArgv; setStyle(false);
    if (wasTTY === undefined) delete (process.stdout as any).isTTY; else (process.stdout as any).isTTY = wasTTY;
  }
});

// ---- version fallback
test('the program version falls back to 0.0.0 when package.json cannot be read', (t) => {
  const real = fsMod.readFileSync;
  t.mock.method(fsMod, 'readFileSync', (p: any, ...rest: any[]) => {
    if (String(p).endsWith('package.json')) throw new Error('ENOENT');
    return (real as any)(p, ...rest);
  });
  syncBuiltinESMExports();
  try { assert.equal(buildProgram().version(), '0.0.0'); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.notEqual(buildProgram().version(), '0.0.0', 'real version restored');
});

// ---- init --agents without a usable config
test('init --agents renders the generic section when the config is unreadable', async (t) => {
  writeFileSync(join(cwd, 'n8c.config.json'), '{ not json');
  const cap = capture(t);
  await runCli(['init', '--agents', '--project-only']);
  assert.match(cap.text(), /AGENTS\.md created/);
  const md = readFileSync(join(cwd, 'AGENTS.md'), 'utf8');
  assert.match(md, /n8c\//, 'default root rendered');
});

test('init --agents treats a config without `database` as sqlite', async (t) => {
  writeFileSync(join(cwd, 'n8c.config.json'), '{}');
  const cap = capture(t);
  await runCli(['init', '--agents', '--project-only']);
  assert.match(cap.text(), /AGENTS\.md created/);
  const sqliteMd = readFileSync(join(cwd, 'AGENTS.md'), 'utf8');
  rmSync(join(cwd, 'AGENTS.md'));
  writeFileSync(join(cwd, 'n8c.config.json'), JSON.stringify({ database: 'mongodb' }));
  await runCli(['init', '--agents', '--project-only']);
  assert.notEqual(readFileSync(join(cwd, 'AGENTS.md'), 'utf8'), sqliteMd, 'mongodb renders differently from the sqlite default');
});

// ---- a mongodb backend, through a stubbed driver client
function stubMongo(t: any, hello: any) {
  const finds: any[] = [];
  const col = {
    createIndex: async () => 'idx',
    find: (f: any) => { finds.push(f); const cur = { sort: () => cur, toArray: async () => [] }; return cur; },
  };
  const db = { collection: () => col, admin: () => ({ command: async () => hello }) };
  t.mock.method(MongoClient.prototype, 'connect', async function (this: any) { return this; });
  t.mock.method(MongoClient.prototype, 'close', async () => {});
  t.mock.method(MongoClient.prototype, 'db', () => db);
  process.env.MONGO_URI = 'mongodb://stub'; process.env.MONGO_DB = 'n8c_test';
  writeFileSync(join(cwd, 'n8c.config.json'), JSON.stringify({ database: 'mongodb' }));
  return finds;
}

test('init on mongodb reports a replica set', async (t) => {
  stubMongo(t, { setName: 'rs0' });
  const cap = capture(t);
  await runCli(['init', '--db-only']);
  assert.match(cap.text(), /DB indexes reconciled: /);
  assert.match(cap.text(), /replica set: OK \(transactions supported\)/);
  assert.doesNotMatch(cap.text(), /prompt-content feature is disabled/);
});

test('init on mongodb warns when it is not a replica set', async (t) => {
  stubMongo(t, {});
  const cap = capture(t);
  await runCli(['init', '--db-only']);
  assert.match(cap.text(), /WARNING: not a replica set — apply transactions will fail/);
  assert.doesNotMatch(cap.text(), /replica set: OK/);
});

test('list on mongodb also reads the prompt-content kind', async (t) => {
  const finds = stubMongo(t, {});
  capture(t);
  await runCli(['list']);
  const kinds = finds.map((f) => f.kind).filter(Boolean);
  assert.deepEqual([...new Set(kinds)].sort(), ['credentials', 'promptContents', 'prompts', 'workflows']);
});

// ---- types: no n8n, odd credentials, root == cwd
test('types works without an n8n connection and writes tsconfig for a root at the project dir', async (t) => {
  writeFileSync(join(cwd, 'n8c.config.json'), JSON.stringify({ root: '.' }));
  const cap = capture(t);
  await runCli(['init', '--db-only']);
  await runCli(['types']); // no N8N_BASE → ctx.n8n undefined
  assert.match(cap.text(), /types written → .*n8c\.types\.ts/);
  assert.ok(existsSync(join(cwd, 'n8c.types.ts')), 'written at the project root');
  const ts = JSON.parse(readFileSync(join(cwd, 'tsconfig.json'), 'utf8'));
  assert.match(JSON.stringify(ts), /n8c/, 'empty relative root falls back to n8c');
});

test('types skips server credentials that have no type', async (t) => {
  const fake = await withFake({ credentials: [{ id: 'c1', name: 'Typeless' }, { id: 'c2', name: 'H', type: 'httpHeaderAuth' }] });
  const cap = capture(t);
  await runCli(['init', '--db-only']);
  await runCli(['types']);
  assert.match(cap.text(), /types written → /);
  const schemaCalls = fake.calls.filter((c) => c.url.startsWith('/api/v1/credentials/schema/')).map((c) => c.url);
  assert.deepEqual(schemaCalls, ['/api/v1/credentials/schema/httpHeaderAuth'], 'only the typed credential is looked up');
});

// ---- pull: non-Error failures are stringified
function failWritesWith(t: any, match: RegExp, thrown: unknown) {
  const real = fsMod.writeFileSync;
  t.mock.method(fsMod, 'writeFileSync', (p: any, ...rest: any[]) => {
    if (match.test(String(p))) throw thrown;
    return (real as any)(p, ...rest);
  });
  syncBuiltinESMExports();
}

test('pull reports a non-Error types failure as text', async (t) => {
  await withFake({ workflows: [WF('W1', 'Main')] });
  const cap = capture(t);
  await runCli(['init', '--db-only']);
  failWritesWith(t, /n8c\.types\.ts$/, 'types disk full');
  try { await runCli(['pull']); } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.match(cap.errText(), /⚠ types skipped: types disk full/);
  assert.ok(existsSync(wfMetaPath()), 'export still happened');
});

test('pull reports a non-Error export failure as text', async (t) => {
  await withFake({ workflows: [WF('W1', 'Main')] });
  const cap = capture(t);
  await runCli(['init', '--db-only']);
  failWritesWith(t, /workflows[\\/].*metadata\.json$/, 'export disk full');
  try { await runCli(['pull']); } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.match(cap.errText(), /⚠ export skipped for workflow: export disk full/);
  assert.match(cap.text(), /✓ generation/, 'the pull itself still committed');
});

// ---- restore --apply with a failing baseline refresh
test('restore --apply warns when the post-apply baseline cannot be refreshed', async (t) => {
  const { fake, cap, first } = await twoGenerations(t);
  fake.fail.push((c, calls) => c.method === 'GET' && c.url.startsWith('/api/v1/workflows') && calls.some((x) => x.method === 'PUT' && x.body?.name === 'Main'));
  cap.out.length = 0;
  await runCli(['restore', first, '--apply']);
  assert.match(cap.text(), /could not refresh the post-apply baseline/);
  assert.match(cap.text(), /Apply complete: 1 applied, 0 failed\./);
  const dir = join(cwd, '.states');
  const st = JSON.parse(readFileSync(join(dir, readdirSync(dir)[0]), 'utf8'));
  assert.equal(st.serverListed, false);
  assert.equal(st.serverFacts, undefined);
});

// ---- entry-point detection (subprocess: the module is loaded fresh)
// Spawn the node binary running this suite (not whatever `node` is first on PATH),
// with a timeout so a hung child fails its test instead of stalling the run.
const SPAWN_TIMEOUT_MS = 30_000;

test('running the CLI with no command prints help and exits 0', () => {
  const out = execFileSync(process.execPath, [CLI_SRC], { cwd, encoding: 'utf8', timeout: SPAWN_TIMEOUT_MS });
  assert.match(out, /Usage: n8c/);
  assert.match(out, /Commands:/);
});

test('importing the CLI module never runs main (no argv[1], or an argv[1] that does not resolve)', () => {
  const code = `const m = await import(${JSON.stringify(pathToFileURL(CLI_SRC).href)}); console.log('imported', typeof m.buildProgram);`;
  const noArg = execFileSync(process.execPath, ['--input-type=module', '-e', code], { cwd, encoding: 'utf8', timeout: SPAWN_TIMEOUT_MS });
  assert.equal(noArg.trim(), 'imported function', 'no argv[1]: not the entry point, no help printed');
  const badArg = execFileSync(process.execPath, ['--input-type=module', '-e', code, join(cwd, 'does-not-exist')], { cwd, encoding: 'utf8', timeout: SPAWN_TIMEOUT_MS });
  assert.equal(badArg.trim(), 'imported function', 'unresolvable argv[1]: not the entry point');
});

test('invalid n8nVersion fails a DB-only command (list) at context build', async () => {
  writeFileSync(join(cwd, 'n8c.config.json'), JSON.stringify({ n8nVersion: '1' }));
  await assert.rejects(runCli(['list']), /unsupported n8nVersion "1" — n8c supports n8n 2 and 3/);
});

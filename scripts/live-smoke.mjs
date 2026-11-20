// Live smoke test: drives the compiled n8c CLI (dist/cli.js) against a REAL n8n
// running in Docker, and checks n8n's actual state through its public API after
// every step. The n8n is a throwaway: its port is bound to 127.0.0.1 only,
// telemetry is off, and the owner account and API key it gets are generated here
// and never printed. The container is removed at the end.
//
//   npm run build
//   node scripts/live-smoke.mjs <n8n version> <host port> <n8nVersion 2|3>
//   e.g. node scripts/live-smoke.mjs 3.3.0 5681 3
//
// Needs the docker CLI pointed at a running engine (DOCKER_HOST or a docker
// context); the first run of a version pulls its n8nio/n8n image (about 2 GB).
// Checks for features an n8n version lacks are adjusted by version: no workflow
// description before 2.16, no archive endpoint before 2.15. Exits 1 when any check
// fails. The full log (every n8c command and its output) goes to a temp folder.
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';

const [TAG, PORT, API] = process.argv.slice(2);
if (!/^\d+\.\d+\.\d+$/.test(TAG ?? '') || !/^\d+$/.test(PORT ?? '') || !['2', '3'].includes(API)) {
  console.error('usage: node scripts/live-smoke.mjs <n8n version, e.g. 3.3.0> <host port> <n8nVersion 2|3>');
  process.exit(2);
}
const [MAJ, MIN] = TAG.split('.').map(Number);
const atLeast = (maj, min) => MAJ > maj || (MAJ === maj && MIN >= min);
const HAS_DESCRIPTION = atLeast(2, 16); // n8n 2.0-2.15 refuse `description` in a workflow body
const HAS_ARCHIVE = atLeast(2, 15);     // POST /workflows/{id}/archive arrived in 2.15
const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
if (!existsSync(CLI)) { console.error(`${CLI} not found: run \`npm run build\` first`); process.exit(2); }
const BASE = `http://127.0.0.1:${PORT}`;
const CONTAINER = `n8c-smoke-${TAG.replace(/\./g, '-')}`;
const DOCKER_ENV = process.env; // the docker CLI's own configuration: DOCKER_HOST, context
const RUN_DIR = mkdtempSync(join(tmpdir(), `n8c-live-smoke-${TAG}-`));
const LOG_FILE = join(RUN_DIR, 'log.txt');

// ---------- reporting ----------
const lines = [];
const log = (s) => lines.push(s);
const checks = [];
function check(label, ok, detail = '') {
  checks.push({ label, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? `  [${String(detail).slice(0, 400)}]` : ''}`);
  log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  [${detail}]` : ''}`);
}
const info = (s) => { console.log(`INFO  ${s}`); log(`INFO  ${s}`); };
async function step(title, fn) {
  console.log(`\n## ${title}`); log(`\n## ${title}`);
  try { await fn(); } catch (e) { check(`${title}: ran to the end`, false, e?.stack ?? String(e)); }
}

// ---------- n8n in Docker ----------
const docker = (args) => execFileSync('docker', args, { env: DOCKER_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Resolves once `path` answers 2xx, and with JSON when `json` is set: while n8n starts,
// /rest/settings answers 200 with a plain-text "starting up" page.
async function waitFor(path, { json = false, timeoutMs = 240000 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(BASE + path);
      if (r.ok && (!json || (r.headers.get('content-type') ?? '').includes('json'))) return Date.now() - t0;
    } catch {}
    await sleep(1000);
  }
  throw new Error(`n8n ${TAG} did not answer ${path} within ${timeoutMs / 1000}s`);
}

// Internal REST (owner session) — only to bootstrap the instance and to read back
// what the public API cannot show (credential data).
const browserId = randomUUID();
let cookie = '';
async function rest(method, path, body) {
  const res = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', 'browser-id': browserId, ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  for (const c of res.headers.getSetCookie()) { const m = /^(n8n-auth=[^;]+)/.exec(c); if (m) cookie = m[1]; }
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : undefined; } catch { json = text; }
  if (!res.ok) throw Object.assign(new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 400)}`), { status: res.status });
  return json;
}

// Public API — the same surface n8c uses, as the judge of what n8n really holds.
let API_KEY = '';
async function api(method, path, body) {
  const res = await fetch(`${BASE}/api/v1${path}`, { method, headers: { 'X-N8N-API-KEY': API_KEY, 'content-type': 'application/json', accept: 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : undefined; } catch { json = text; }
  if (!res.ok) throw Object.assign(new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 400)}`), { status: res.status });
  return json;
}
async function all(path) {
  const out = []; let cursor;
  do {
    const sep = path.includes('?') ? '&' : '?';
    const page = await api('GET', cursor ? `${path}${sep}cursor=${encodeURIComponent(cursor)}` : path);
    out.push(...(page?.data ?? [])); cursor = page?.nextCursor ?? undefined;
  } while (cursor);
  return out;
}
const workflows = () => all('/workflows');
const credentials = () => all('/credentials');
const getWf = (id) => api('GET', `/workflows/${id}`);
const published = (w) => ('activeVersionId' in w ? w.activeVersionId != null : !!w.active);
const isCurrent = (w) => !('activeVersionId' in w) || w.activeVersionId === w.versionId;

// ---------- the CLI ----------
const ENC_KEY = randomBytes(24).toString('hex');
const baseEnv = () => ({ PATH: process.env.PATH, HOME: process.env.HOME, NO_COLOR: '1', N8N_BASE: BASE, N8N_API_KEY: API_KEY, N8C_CREDENTIAL_ENCRYPTION_KEY: ENC_KEY });
function n8c(cwd, args, extra = {}) {
  return new Promise((resolve) => execFile(process.execPath, [CLI, ...args], { cwd, env: { ...baseEnv(), ...extra }, maxBuffer: 1 << 26 }, (err, stdout, stderr) => {
    const r = { code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr, out: `${stdout}${stderr}`.trim() };
    r.calls = stderr.split('\n').filter((l) => l.startsWith('→ ')).map((l) => l.slice(2).trim());
    log(`$ n8c ${args.join(' ')}   [exit ${r.code}]\n    ${r.out.split('\n').join('\n    ')}`);
    resolve(r);
  }));
}
const stateFile = (cwd) => join(cwd, '.states', 'n8c.state.json'); // env "default" (src/engine/state.ts statePath)
const describe = (r) => `${r.action} ${r.kind} ${r.name}${r.fields ? ` (${r.fields.join(',')})` : ''}${r.nodes?.length ? ` nodes[${r.nodes.map((n) => `${n.name}:${n.status}`).join(',')}]` : ''}${r.setActive !== undefined ? ` setActive=${r.setActive}` : ''}${r.archived ? ' archived' : ''}`;
async function plan(cwd, args = [], extra = {}) {
  rmSync(stateFile(cwd), { force: true });
  const r = await n8c(cwd, ['plan', ...args], extra);
  let st; try { st = JSON.parse(readFileSync(stateFile(cwd), 'utf8')); } catch {}
  const changes = st ? st.resources.filter((x) => x.action !== 'noop').map(describe) : ['(no state written)'];
  return { r, st, changes };
}
const idOf = (r) => /created \w+ ([0-9a-f-]{36})/.exec(r.out)?.[1];
function editJson(file, fn) { const v = JSON.parse(readFileSync(file, 'utf8')); writeFileSync(file, JSON.stringify(fn(v), null, 2) + '\n'); }
function tree(dir, base = dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const n of readdirSync(dir)) { const p = join(dir, n); if (statSync(p).isDirectory()) tree(p, base, out); else out.push(relative(base, p)); }
  return out;
}
const grepTree = (dir, needle) => tree(dir).filter((f) => readFileSync(join(dir, f)).includes(needle));
const dbHas = (cwd, needle) => ['n8c.sqlite', 'n8c.sqlite-wal'].some((f) => { try { return readFileSync(join(cwd, f)).includes(needle); } catch { return false; } });

function finish() {
  const r = spawnSync('docker', ['logs', '--tail', '120', CONTAINER], { env: DOCKER_ENV, encoding: 'utf8' });
  log(`\n--- docker logs ${CONTAINER} (tail) ---\n${r.stdout}${r.stderr}`);
  spawnSync('docker', ['rm', '-f', CONTAINER], { env: DOCKER_ENV, stdio: 'ignore' });
  writeFileSync(LOG_FILE, lines.join('\n') + '\n');
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n=== n8n ${TAG} (n8nVersion "${API}"): ${checks.length - failed.length}/${checks.length} checks passed — log: ${LOG_FILE}`);
  for (const f of failed) console.log(`  FAILED: ${f.label}`);
  process.exitCode = failed.length ? 1 : 0;
}

// =====================================================================
const SECRET1 = `smoke-one-${randomBytes(6).toString('hex')}`;
const SECRET2 = `smoke-two-${randomBytes(6).toString('hex')}`;
const SECRET3 = `smoke-three-${randomBytes(6).toString('hex')}`;
let personalProjectId;
let ALL_SCOPES = [];

await step(`start n8n ${TAG} in Docker and bootstrap it`, async () => {
  try { docker(['rm', '-f', CONTAINER]); } catch {}
  docker(['run', '-d', '--name', CONTAINER, '-p', `127.0.0.1:${PORT}:5678`,
    ...['N8N_DIAGNOSTICS_ENABLED=false', 'N8N_VERSION_NOTIFICATIONS_ENABLED=false', 'N8N_TEMPLATES_ENABLED=false',
      'N8N_PERSONALIZATION_ENABLED=false', 'N8N_DYNAMIC_BANNERS_ENABLED=false', 'N8N_SECURE_COOKIE=false',
      'GENERIC_TIMEZONE=UTC', 'TZ=UTC'].flatMap((e) => ['-e', e]),
    `n8nio/n8n:${TAG}`]);
  const t0 = Date.now();
  await waitFor('/healthz/readiness');
  await waitFor('/rest/settings', { json: true });
  info(`n8n ${TAG} ready after ${Math.round((Date.now() - t0) / 1000)}s on ${BASE}`);
  const email = `owner-${randomBytes(4).toString('hex')}@example.test`;
  const password = `Sm0ke-${randomBytes(12).toString('base64url')}A1`;
  await rest('POST', '/rest/owner/setup', { email, firstName: 'Smoke', lastName: 'Test', password });
  if (!cookie) await rest('POST', '/rest/login', { emailOrLdapLoginId: email, password });
  const scopes = (await rest('GET', '/rest/api-keys/scopes'))?.data;
  ALL_SCOPES = scopes ?? [];
  const key = (await rest('POST', '/rest/api-keys', { label: 'n8c-smoke', expiresAt: null, scopes }))?.data;
  API_KEY = key?.rawApiKey ?? key?.apiKey ?? '';
  check('throwaway owner + API key created on the local n8n', API_KEY.length > 20 && !API_KEY.includes('*'));
  info(`API key scopes (${scopes?.length ?? '?'}): ${(scopes ?? []).filter((s) => /^(workflow|credential|project)/.test(s)).join(' ')}`);
  try { personalProjectId = (await rest('GET', '/rest/projects/personal'))?.data?.id; } catch (e) { info(`personal project lookup failed: ${e.message}`); }
  info(`personal project id: ${personalProjectId ?? 'unknown'}`);
});
if (!API_KEY) { finish(); process.exit(1); }

const P1 = join(RUN_DIR, 'author'); mkdirSync(P1);
await step('init a fresh project; plan against the empty n8n', async () => {
  const init = await n8c(P1, ['init']);
  check('init exits 0', init.code === 0, init.out);
  editJson(join(P1, 'n8c.config.json'), (c) => ({ ...c, n8nVersion: API }));
  const p = await plan(P1);
  check('plan exits 0 with nothing to do', p.r.code === 0 && p.changes.length === 0, p.changes.join('; ') || p.r.out);
});

let C1, W1, N1, N2, N3, N4, wfDir;
let HELPER = '';
const setHelper = (v) => { HELPER = v; writeFileSync(join(P1, 'src', 'shape', 'helpers.ts'), `export function tag(json) {\n  return { ...json, smoke: '${v}' };\n}\n`); };
await step('author a credential, a 4-node workflow and a src unit with the CLI', async () => {
  C1 = idOf(await n8c(P1, ['create', 'credential', '--name', 'Smoke API', '--type', 'httpHeaderAuth']));
  W1 = idOf(await n8c(P1, ['create', 'workflow', '--name', 'Smoke Main']));
  const node = async (name, type) => idOf(await n8c(P1, ['create', 'node', '--workflow', W1, '--name', name, '--type', type]));
  N1 = await node('Every Hour', 'n8n-nodes-base.scheduleTrigger');
  N2 = await node('Call API', 'n8n-nodes-base.httpRequest');
  N3 = await node('Shape', 'n8n-nodes-base.code');
  N4 = await node('Done', 'n8n-nodes-base.noOp');
  check('create credential, workflow and 4 nodes', !!(C1 && W1 && N1 && N2 && N3 && N4));
  wfDir = join(P1, 'n8c', 'workflows', W1);
  const credApply = readFileSync(join(P1, 'n8c', 'credentials', C1, 'apply.ts'), 'utf8');
  check('credential scaffold: httpHeaderAuth name/value, secret from SMOKE_API_TOKEN', /data: \{ name: 'Authorization', value: process\.env\.SMOKE_API_TOKEN \}/.test(credApply), credApply);
  const setNode = (n, typeVersion, position, params, creds) => {
    const d = join(wfDir, 'nodes', n);
    editJson(join(d, 'metadata.json'), (m) => ({ ...m, typeVersion, position }));
    writeFileSync(join(d, 'apply.ts'), `export default ${JSON.stringify(params, null, 2)};\n`);
    if (creds) writeFileSync(join(d, 'credentials.ts'), `export default ${JSON.stringify(creds)};\n`);
  };
  setNode(N1, 1.2, [0, 0], { rule: { interval: [{ field: 'hours', hoursInterval: 1 }] } });
  setNode(N2, 4.2, [220, 0], { method: 'GET', url: 'https://example.invalid/ping', authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth', options: {} }, { httpHeaderAuth: C1 });
  setNode(N3, 2, [440, 0], {});
  setNode(N4, 1, [660, 0], {});
  const link = (to) => ({ main: [[{ node: to, type: 'main', index: 0 }]] });
  editJson(join(wfDir, 'metadata.json'), (m) => ({ ...m, active: true, settings: { executionOrder: 'v1' }, connections: { [N1]: link(N2), [N2]: link(N3), [N3]: link(N4) } }));
  const unit = join(P1, 'src', 'shape'); mkdirSync(unit, { recursive: true });
  writeFileSync(join(unit, 'metadata.json'), JSON.stringify({ target: N3 }) + '\n');
  setHelper('v1');
  writeFileSync(join(unit, 'code.ts'), "import { tag } from './helpers.ts';\n\nreturn items.map((item) => ({ json: tag(item.json) }));\n");
});

let wf1, cred1;
await step('plan + apply creates both on n8n and publishes the workflow', async () => {
  const p = await plan(P1, [], { SMOKE_API_TOKEN: SECRET1 });
  check('plan: create credential + create workflow (to be activated)', p.r.code === 0 && p.changes.some((c) => c.startsWith('create credentials Smoke API')) && p.changes.some((c) => c.startsWith('create workflows Smoke Main') && c.includes('setActive=true')), p.changes.join('; ') || p.r.out);
  const a = await n8c(P1, ['apply', '-m', 'smoke-1-create', '--debug'], { SMOKE_API_TOKEN: SECRET1 });
  check('apply exits 0', a.code === 0, a.out);
  check('--debug output never shows the secret', !a.out.includes(SECRET1));
  info(`writes: ${a.calls.filter((c) => !c.startsWith('GET')).join(' | ')}`);
  const creds = await credentials();
  cred1 = creds.find((c) => c.name === 'Smoke API');
  check('n8n has exactly one credential "Smoke API" (httpHeaderAuth)', creds.filter((c) => c.name === 'Smoke API').length === 1 && cred1?.type === 'httpHeaderAuth', JSON.stringify(creds));
  const mine = (await workflows()).filter((w) => w.name === 'Smoke Main');
  check('n8n has exactly one workflow "Smoke Main"', mine.length === 1, `${mine.length}`);
  wf1 = await getWf(mine[0].id);
  log(`n8n workflow after create:\n${JSON.stringify(wf1, null, 2)}`);
  check('workflow is published, at its current version', published(wf1) && isCurrent(wf1), `active=${wf1.active} versionId=${wf1.versionId} activeVersionId=${wf1.activeVersionId}`);
  const byName = Object.fromEntries(wf1.nodes.map((n) => [n.name, n]));
  check('4 nodes with the authored types', wf1.nodes.length === 4 && byName['Every Hour']?.type === 'n8n-nodes-base.scheduleTrigger' && byName['Done']?.type === 'n8n-nodes-base.noOp', wf1.nodes.map((n) => `${n.name}:${n.type}`).join(','));
  check('Call API is bound to the new n8n credential id', !!cred1 && byName['Call API']?.credentials?.httpHeaderAuth?.id === cred1.id, JSON.stringify(byName['Call API']?.credentials));
  const js = byName['Shape']?.parameters?.jsCode ?? '';
  check('Shape jsCode is the src unit, inlined (helper v1, no import left)', /smoke: 'v1'/.test(js) && !/\bimport\b/.test(js), js);
  check('connections Every Hour → Call API → Shape → Done', wf1.connections?.['Every Hour']?.main?.[0]?.[0]?.node === 'Call API' && wf1.connections?.['Call API']?.main?.[0]?.[0]?.node === 'Shape' && wf1.connections?.['Shape']?.main?.[0]?.[0]?.node === 'Done', JSON.stringify(wf1.connections));
  if (HAS_DESCRIPTION) check('description carries the [n8c-managed] marker', /\[n8c-managed\]/.test(wf1.description ?? ''), `description=${JSON.stringify(wf1.description)}`);
  else check('n8n before 2.16: the create was sent again without description, with no warning (only the marker was dropped)', a.calls.filter((c) => c === 'POST /api/v1/workflows').length === 2 && wf1.description == null && !/saved without its description/.test(a.out), JSON.stringify({ description: wf1.description, posts: a.calls.filter((c) => c === 'POST /api/v1/workflows').length }));
  const listed = (await workflows()).find((w) => w.id === wf1.id);
  info(`GET /workflows (the list n8c plans and pulls from) returns description: ${listed && 'description' in listed ? JSON.stringify(listed.description) : 'NO such key'}; GET /workflows/{id} returns ${JSON.stringify(wf1.description)}`);
  check('settings.executionOrder = v1', wf1.settings?.executionOrder === 'v1', JSON.stringify(wf1.settings));
});

await step('re-plan right after apply is clean (n8n defaults cause no perpetual diff)', async () => {
  const p = await plan(P1, [], { SMOKE_API_TOKEN: SECRET1 });
  check('plan shows no changes', p.r.code === 0 && p.changes.length === 0, p.changes.join('; ') || p.r.out);
  const before = await getWf(wf1.id); const credBefore = (await credentials()).find((c) => c.id === cred1.id);
  const a = await n8c(P1, ['apply', '--debug'], { SMOKE_API_TOKEN: SECRET1 });
  const writes = a.calls.filter((c) => !c.startsWith('GET'));
  check('apply of a clean plan sends no writes to n8n', a.code === 0 && writes.length === 0, writes.join(', ') || a.out);
  const after = await getWf(wf1.id); const credAfter = (await credentials()).find((c) => c.id === cred1.id);
  check('workflow versionId and credential updatedAt unchanged', before.versionId === after.versionId && credBefore?.updatedAt === credAfter?.updatedAt);
});

await step('a unit-only edit plans as a workflow update and deploys', async () => {
  setHelper('v2');
  const p = await plan(P1, [], { SMOKE_API_TOKEN: SECRET1 });
  check('plan: update Smoke Main (node Shape changed)', p.changes.length === 1 && /^update workflows Smoke Main.*Shape:changed/.test(p.changes[0]), p.changes.join('; '));
  const a = await n8c(P1, ['apply', '-m', 'smoke-2-unit'], { SMOKE_API_TOKEN: SECRET1 });
  const w = await getWf(wf1.id);
  const js = w.nodes.find((n) => n.name === 'Shape')?.parameters?.jsCode ?? '';
  check('apply exits 0; n8n has helper v2', a.code === 0 && /smoke: 'v2'/.test(js), a.code ? a.out : js);
  check('still published, at the new version', published(w) && isCurrent(w), `versionId=${w.versionId} activeVersionId=${w.activeVersionId}`);
});

await step('rename + settings.timezone reach n8n', async () => {
  editJson(join(wfDir, 'metadata.json'), (m) => ({ ...m, name: 'Smoke Main Renamed', settings: { ...m.settings, timezone: 'Europe/Berlin' } }));
  const p = await plan(P1, [], { SMOKE_API_TOKEN: SECRET1 });
  check('plan: update with fields name, settings.timezone', p.changes.length === 1 && /\(name,settings\.timezone\)/.test(p.changes[0]), p.changes.join('; ') || p.r.out);
  const a = await n8c(P1, ['apply', '-m', 'smoke-3-rename'], { SMOKE_API_TOKEN: SECRET1 });
  check('apply exits 0', a.code === 0, a.out);
  const w = await getWf(wf1.id);
  check('n8n: name and timezone updated on the same workflow', w.name === 'Smoke Main Renamed' && w.settings?.timezone === 'Europe/Berlin', JSON.stringify({ name: w.name, settings: w.settings }));
  check('still exactly one Smoke Main… workflow', (await workflows()).filter((x) => x.name.startsWith('Smoke Main')).length === 1);
  check('still published, at the new version', published(w) && isCurrent(w));
  const p2 = await plan(P1, [], { SMOKE_API_TOKEN: SECRET1 });
  check('plan afterwards is clean', p2.changes.length === 0, p2.changes.join('; '));
});

await step('active:false unpublishes; active:true publishes again', async () => {
  const [off, on] = API === '3' ? ['/unpublish', '/publish'] : ['/deactivate', '/activate'];
  editJson(join(wfDir, 'metadata.json'), (m) => ({ ...m, active: false }));
  let p = await plan(P1, [], { SMOKE_API_TOKEN: SECRET1 });
  check('plan: update with setActive=false only', p.changes.length === 1 && / setActive=false$/.test(p.changes[0]) && !/nodes\[|\(/.test(p.changes[0]), p.changes.join('; '));
  let a = await n8c(P1, ['apply', '--debug'], { SMOKE_API_TOKEN: SECRET1 });
  let w = await getWf(wf1.id);
  check(`apply calls ${off}; n8n workflow is unpublished`, a.code === 0 && a.calls.some((c) => c.endsWith(off)) && !published(w), `${a.calls.filter((c) => !c.startsWith('GET')).join(' | ')} active=${w.active} activeVersionId=${w.activeVersionId}`);
  editJson(join(wfDir, 'metadata.json'), (m) => ({ ...m, active: true }));
  p = await plan(P1, [], { SMOKE_API_TOKEN: SECRET1 });
  a = await n8c(P1, ['apply', '--debug'], { SMOKE_API_TOKEN: SECRET1 });
  w = await getWf(wf1.id);
  check(`apply calls ${on}; n8n workflow is published again`, a.code === 0 && a.calls.some((c) => c.endsWith(on)) && published(w) && isCurrent(w), `${a.calls.filter((c) => !c.startsWith('GET')).join(' | ')}`);
  p = await plan(P1, [], { SMOKE_API_TOKEN: SECRET1 });
  check('plan afterwards is clean', p.changes.length === 0, p.changes.join('; '));
});

await step('rotating the secret PATCHes the same credential in place', async () => {
  const before = (await credentials()).find((c) => c.id === cred1.id);
  const p = await plan(P1, [], { SMOKE_API_TOKEN: SECRET2 });
  check('plan: update credential Smoke API only', p.changes.length === 1 && /^update credentials Smoke API/.test(p.changes[0]), p.changes.join('; '));
  const a = await n8c(P1, ['apply', '-m', 'smoke-4-rotate', '--debug'], { SMOKE_API_TOKEN: SECRET2 });
  const creds = await credentials();
  const after = creds.find((c) => c.id === cred1.id);
  check('apply exits 0: PATCH to the same id, no POST', a.code === 0 && a.calls.includes(`PATCH /api/v1/credentials/${cred1.id}`) && !a.calls.some((c) => c.startsWith('POST /api/v1/credentials')), a.calls.join(' | '));
  check('still one "Smoke API" credential, and its updatedAt moved', creds.filter((c) => c.name === 'Smoke API').length === 1 && !!after && after.updatedAt !== before?.updatedAt, `${before?.updatedAt} -> ${after?.updatedAt}`);
  check('--debug output never shows either secret', !a.out.includes(SECRET1) && !a.out.includes(SECRET2));
  check('neither secret is stored in plain text in the local DB', !dbHas(P1, SECRET1) && !dbHas(P1, SECRET2));
  const w = await getWf(wf1.id);
  check('the workflow is still bound to the same credential id', w.nodes.find((n) => n.name === 'Call API')?.credentials?.httpHeaderAuth?.id === cred1.id);
});

await step('a credential edited in the n8n UI is detected and restored from the file', async () => {
  await api('PATCH', `/credentials/${cred1.id}`, { type: 'httpHeaderAuth', data: { name: 'X-Edited-In-UI', value: 'edited' } });
  const p = await plan(P1, [], { SMOKE_API_TOKEN: SECRET2 });
  check('plan: update credential Smoke API (the n8n-side edit is noticed)', p.changes.length === 1 && /^update credentials Smoke API/.test(p.changes[0]), p.changes.join('; '));
  const a = await n8c(P1, ['apply'], { SMOKE_API_TOKEN: SECRET2 });
  check('apply exits 0', a.code === 0, a.out);
  let restored;
  try { restored = (await rest('GET', `/rest/credentials/${cred1.id}?includeData=true`))?.data?.data; } catch (e) { info(`could not read credential data back: ${e.message}`); }
  if (restored) check('n8n holds the file\'s header name again (Authorization)', restored.name === 'Authorization', JSON.stringify({ name: restored.name }));
});

await step('apply refuses a saved plan once n8n changed; a fresh plan restores the files', async () => {
  setHelper('v3');
  const p = await plan(P1, [], { SMOKE_API_TOKEN: SECRET2 });
  check('plan: update (Shape changed)', p.changes.length === 1 && /Shape:changed/.test(p.changes[0]), p.changes.join('; '));
  // someone edits the workflow in n8n in the meantime
  const cur = await getWf(wf1.id);
  const NODE_KEYS = ['id', 'name', 'webhookId', 'disabled', 'notesInFlow', 'notes', 'type', 'typeVersion', 'executeOnce', 'alwaysOutputData', 'retryOnFail', 'maxTries', 'waitBetweenTries', 'continueOnFail', 'onError', 'position', 'parameters', 'credentials'];
  const nodes = cur.nodes.map((n) => Object.fromEntries(Object.entries(n).filter(([k]) => NODE_KEYS.includes(k))));
  nodes.find((n) => n.name === 'Call API').parameters.url = 'https://example.invalid/edited-in-ui';
  const settings = Object.fromEntries(Object.entries(cur.settings ?? {}).filter(([k]) => ['executionOrder', 'timezone'].includes(k)));
  await api('PUT', `/workflows/${wf1.id}`, { name: cur.name, nodes, connections: cur.connections, settings });
  const blocked = await n8c(P1, ['apply'], { SMOKE_API_TOKEN: SECRET2 });
  check('apply on the stale plan exits 1 and says n8n changed', blocked.code === 1 && /n8n changed since this plan was made/.test(blocked.out), blocked.out);
  let w = await getWf(wf1.id);
  check('the refused apply left n8n alone (UI edit kept, helper still v2)', w.nodes.find((n) => n.name === 'Call API')?.parameters?.url === 'https://example.invalid/edited-in-ui' && /smoke: 'v2'/.test(w.nodes.find((n) => n.name === 'Shape')?.parameters?.jsCode ?? ''));
  const p2 = await plan(P1, [], { SMOKE_API_TOKEN: SECRET2 });
  check('a fresh plan shows both the n8n edit (Call API) and the unit edit (Shape)', p2.changes.length === 1 && /Call API:changed/.test(p2.changes[0]) && /Shape:changed/.test(p2.changes[0]), p2.changes.join('; '));
  const a = await n8c(P1, ['apply', '-m', 'smoke-5-drift'], { SMOKE_API_TOKEN: SECRET2 });
  w = await getWf(wf1.id);
  check('apply restores the files on n8n (url back, helper v3), still published', a.code === 0 && w.nodes.find((n) => n.name === 'Call API')?.parameters?.url === 'https://example.invalid/ping' && /smoke: 'v3'/.test(w.nodes.find((n) => n.name === 'Shape')?.parameters?.jsCode ?? '') && published(w) && isCurrent(w), a.code ? a.out : '');
});

await step('a key without the publish permission: n8n keeps the update as a draft, n8c says so, the same plan finishes it', async () => {
  const noPublish = ALL_SCOPES.filter((s) => !/^workflow:(activate|deactivate|publish|unpublish)$/.test(s));
  let LIMITED;
  try { const k = (await rest('POST', '/rest/api-keys', { label: 'n8c-smoke-no-publish', expiresAt: null, scopes: noPublish }))?.data; LIMITED = k?.rawApiKey ?? k?.apiKey; }
  catch (e) { info(`skipped: could not create a scoped API key (${e.message})`); return; }
  const jsOf = (w) => w.nodes.find((n) => n.name === 'Shape')?.parameters?.jsCode ?? '';
  setHelper('v4');
  await plan(P1, [], { SMOKE_API_TOKEN: SECRET2 });
  const before = await getWf(wf1.id);
  const a = await n8c(P1, ['apply'], { SMOKE_API_TOKEN: SECRET2, N8N_API_KEY: LIMITED });
  const after = await getWf(wf1.id);
  if (a.code === 0) { info(`skipped: this n8n does not enforce API key scopes (the publish went through with a key lacking ${ALL_SCOPES.filter((s) => !noPublish.includes(s)).join(', ')})`); return; }
  check('apply exits 1 and explains that n8n kept the update as a DRAFT', /saved the new version of workflow \S+ as a DRAFT/.test(a.out), a.out);
  check('n8n saved the draft (helper v4) but still publishes the previous version', /smoke: 'v4'/.test(jsOf(after)) && after.versionId !== before.versionId && after.activeVersionId === before.activeVersionId && published(after), JSON.stringify({ before: [before.versionId, before.activeVersionId], after: [after.versionId, after.activeVersionId] }));
  const retry = await n8c(P1, ['apply'], { SMOKE_API_TOKEN: SECRET2 }); // the SAME saved plan, full key
  const fin = await getWf(wf1.id);
  check('re-running apply on the same saved plan with a full key publishes v4', retry.code === 0 && /smoke: 'v4'/.test(jsOf(fin)) && published(fin) && isCurrent(fin), retry.out);
  const p = await plan(P1, [], { SMOKE_API_TOKEN: SECRET2 });
  check('plan afterwards is clean', p.changes.length === 0, p.changes.join('; '));
});

await step('a scaffold left unfilled fails, with n8n naming the missing field', async () => {
  const chat = idOf(await n8c(P1, ['create', 'credential', '--name', 'Chat', '--type', 'slackApi']));
  const scaffold = readFileSync(join(P1, 'n8c', 'credentials', chat, 'apply.ts'), 'utf8');
  log(`slackApi scaffold:\n${scaffold}`);
  await plan(P1, [], { SMOKE_API_TOKEN: SECRET2 });
  const a = await n8c(P1, ['apply'], { SMOKE_API_TOKEN: SECRET2 });
  check('apply exits 1 with "failed ✗ credential Chat" and n8n\'s reason naming accessToken', a.code === 1 && /failed ✗ credential Chat/.test(a.out) && /accessToken/.test(a.out), a.out);
  check('no "Chat" credential was created on n8n', !(await credentials()).some((c) => c.name === 'Chat'));
  check('the failure does not claim a mapped id', !/mapped id/.test(a.out));
  rmSync(join(P1, 'n8c', 'credentials', chat), { recursive: true, force: true });
  const p2 = await plan(P1, [], { SMOKE_API_TOKEN: SECRET2 });
  check('after deleting its folder, plan is clean again', p2.changes.length === 0 && !(p2.st?.orphans ?? []).length, `${p2.changes.join('; ')} orphans=${JSON.stringify(p2.st?.orphans)}`);
});

await step('n8c types writes the real field names from n8n', async () => {
  const t = await n8c(P1, ['types']);
  const file = join(P1, 'n8c', 'n8c.types.ts');
  const src = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const i = src.indexOf('httpHeaderAuth');
  const near = i >= 0 ? src.slice(i, i + 400) : '';
  log(`n8c.types.ts around httpHeaderAuth:\n${near}`);
  check('types exits 0; n8c.types.ts has httpHeaderAuth with name and value', t.code === 0 && i >= 0 && /\bname\b/.test(near) && /\bvalue\b/.test(near), t.out);
});

await step('list + restore --apply rolls n8n back to an earlier release', async () => {
  const l = await n8c(P1, ['list', '--pipe']);
  const gens = [...l.out.matchAll(/^([* ]) ([0-9a-f]{8}): (smoke-[\w-]+)/gm)].map((m) => ({ active: m[1] === '*', hash: m[2], msg: m[3] }));
  const heads = l.out.split('\n').filter((x) => /^[* ] [0-9a-f]{8}/.test(x));
  check('list shows the 5 tagged releases newest first, and only the newest release is active', l.code === 0 && gens.map((g) => g.msg).join() === 'smoke-5-drift,smoke-4-rotate,smoke-3-rename,smoke-2-unit,smoke-1-create' && heads[0]?.startsWith('* ') && heads.filter((x) => x.startsWith('* ')).length === 1, l.out);
  info(`releases so far: ${heads.length} (${heads.map((x) => x.trim()).join(' | ')})`);
  const g2 = gens.find((g) => g.msg === 'smoke-2-unit');
  const r = await n8c(P1, ['restore', g2.hash, '--apply'], { SMOKE_API_TOKEN: SECRET2 });
  const w = await getWf(wf1.id);
  check('restore --apply exits 0; n8n is back to the old name', r.code === 0 && w.name === 'Smoke Main', r.code ? r.out : `name=${w.name}`);
  // src/shape is not part of any release: restore says so, and n8n keeps the unit's current build.
  check('restore names the node src/shape still feeds', /1 restored node takes its code from a src\/ unit, which restore does not roll back/.test(r.out) && /Smoke Main → Shape/.test(r.out), r.out);
  const shapeJs = w.nodes.find((n) => n.name === 'Shape')?.parameters?.jsCode ?? '';
  check(`…and n8n runs the unit's current code (helper ${HELPER})`, shapeJs.includes(`smoke: '${HELPER}'`), shapeJs);
  check('the restored files hold no secret in plain text', grepTree(join(P1, 'n8c'), SECRET1).length === 0 && grepTree(join(P1, 'n8c'), SECRET2).length === 0);
  check('still one Smoke Main… workflow and one Smoke API credential', (await workflows()).filter((x) => x.name.startsWith('Smoke Main')).length === 1 && (await credentials()).filter((c) => c.name === 'Smoke API').length === 1);
  log(`files after restore: ${tree(join(P1, 'n8c')).join(', ')}`);
  const p = await plan(P1, [], { SMOKE_API_TOKEN: SECRET2 });
  check('plan after restore is clean', p.changes.length === 0, p.changes.join('; '));
});

await step('pull in the authoring project, then plan is clean', async () => {
  const pl = await n8c(P1, ['pull', '-y'], { SMOKE_API_TOKEN: SECRET2 });
  check('pull exits 0', pl.code === 0, pl.out);
  const p = await plan(P1, [], { SMOKE_API_TOKEN: SECRET2 });
  check('plan after pull is clean', p.changes.length === 0, p.changes.join('; '));
  check('pulled files hold no secret in plain text', grepTree(join(P1, 'n8c'), SECRET2).length === 0);
});

// Last of the authoring steps on purpose: if a description diff never settles, it
// must not leak into the steps above. By now `pull` has rewritten Smoke Main into one
// apply.ts, so this is the flat layout: metadata.json holds the description, n8c adds
// no marker, and a key left out of the files is left alone on n8n ("" clears it).
await step('flat layout: a description set in metadata.json reaches n8n, and plan then settles', async () => {
  const env = { SMOKE_API_TOKEN: SECRET2 };
  const meta = join(P1, 'n8c', 'workflows', W1, 'metadata.json');
  info(`metadata.json after the pull: ${readFileSync(meta, 'utf8').trim().replace(/\s+/g, ' ')}`);
  check('pull wrote no description into apply.ts', !/"description"/.test(readFileSync(join(P1, 'n8c', 'workflows', W1, 'apply.ts'), 'utf8')));
  editJson(meta, (m) => ({ ...m, description: 'Live smoke test' }));
  const p = await plan(P1, [], env);
  check('plan: update Smoke Main (description)', p.changes.length === 1 && /\(description\)/.test(p.changes[0]), p.changes.join('; ') || p.r.out);
  const a = await n8c(P1, ['apply', '-m', 'smoke-7-description'], env);
  const w = await getWf(wf1.id);
  const p2 = await plan(P1, [], env);
  if (!HAS_DESCRIPTION) {
    check('n8n before 2.16: apply exits 0, saved without the description, and n8c says so', a.code === 0 && w.description == null && /workflow "Smoke Main" was saved without its description: this n8n refuses workflow descriptions/.test(a.out), a.out);
    check('…plan keeps listing the description, as the warning says', p2.changes.length === 1 && /\(description\)/.test(p2.changes[0]), p2.changes.join('; ') || 'no change');
    editJson(meta, (m) => ({ ...m, description: '' }));
    const p3 = await plan(P1, [], env);
    check('…until the files clear it', p3.changes.length === 0, p3.changes.join('; '));
    return;
  }
  check('apply exits 0; n8n has exactly the description', a.code === 0 && w.description === 'Live smoke test', a.code ? a.out : JSON.stringify(w.description));
  check('plan right after that apply is clean', p2.changes.length === 0, p2.changes.join('; '));
  editJson(meta, (m) => ({ ...m, description: '' }));
  const p3 = await plan(P1, [], env);
  check('clearing it ("") plans an update', p3.changes.length === 1 && /\(description\)/.test(p3.changes[0]), p3.changes.join('; ') || 'plan shows no change');
  const a3 = await n8c(P1, ['apply'], env);
  const w3 = await getWf(wf1.id);
  check('…which reaches n8n', a3.code === 0 && w3.description === '', a3.code ? a3.out : JSON.stringify(w3.description));
  const p4 = await plan(P1, [], env);
  check('plan is clean again', p4.changes.length === 0, p4.changes.join('; '));
});

await step('nodes/ layout: a description deploys with the marker, and removing it leaves only the marker', async () => {
  if (!HAS_DESCRIPTION) { info('skipped: n8n before 2.16 has no workflow descriptions'); return; }
  const env = { SMOKE_API_TOKEN: SECRET2 };
  const W3 = idOf(await n8c(P1, ['create', 'workflow', '--name', 'Smoke Described', '--description', 'Exploded description']));
  await n8c(P1, ['create', 'node', '--workflow', W3, '--name', 'Start', '--type', 'n8n-nodes-base.manualTrigger']);
  const p = await plan(P1, [], env);
  check('plan: create Smoke Described, nothing else', p.changes.length === 1 && p.changes[0].startsWith('create workflows Smoke Described'), p.changes.join('; '));
  const a = await n8c(P1, ['apply'], env);
  const id = (await workflows()).find((x) => x.name === 'Smoke Described')?.id;
  const w = id ? await getWf(id) : {};
  check('apply exits 0; n8n has the description plus the marker', a.code === 0 && w.description === 'Exploded description\n[n8c-managed]', a.code ? a.out : JSON.stringify(w.description));
  const p2 = await plan(P1, [], env);
  check('plan right after is clean', p2.changes.length === 0, p2.changes.join('; '));
  editJson(join(P1, 'n8c', 'workflows', W3, 'metadata.json'), (m) => { const { description, ...rest } = m; return rest; });
  const p3 = await plan(P1, [], env);
  check('removing the description from metadata.json plans an update', p3.changes.length === 1 && /Smoke Described \(description\)/.test(p3.changes[0]), p3.changes.join('; ') || 'no change');
  const a3 = await n8c(P1, ['apply'], env);
  const w3 = id ? await getWf(id) : {};
  check('…and n8n keeps only the marker', a3.code === 0 && w3.description === '[n8c-managed]', a3.code ? a3.out : JSON.stringify(w3.description));
  const p4 = await plan(P1, [], env);
  check('plan is clean again', p4.changes.length === 0, p4.changes.join('; '));
});

let project;
await step('n8nProjectId = the personal project: creates land there, one copy each', async () => {
  if (!personalProjectId) { info('skipped: no personal project id'); return; }
  editJson(join(P1, 'n8c.config.json'), (c) => ({ ...c, n8nProjectId: personalProjectId }));
  const C2 = idOf(await n8c(P1, ['create', 'credential', '--name', 'Smoke Project Key', '--type', 'httpQueryAuth']));
  const W2 = idOf(await n8c(P1, ['create', 'workflow', '--name', 'Smoke Project']));
  const M1 = idOf(await n8c(P1, ['create', 'node', '--workflow', W2, '--name', 'Start', '--type', 'n8n-nodes-base.manualTrigger']));
  const M2 = idOf(await n8c(P1, ['create', 'node', '--workflow', W2, '--name', 'Fetch', '--type', 'n8n-nodes-base.httpRequest']));
  const w2Dir = join(P1, 'n8c', 'workflows', W2);
  editJson(join(w2Dir, 'nodes', M2, 'metadata.json'), (m) => ({ ...m, typeVersion: 4.2, position: [220, 0] }));
  writeFileSync(join(w2Dir, 'nodes', M2, 'apply.ts'), `export default ${JSON.stringify({ url: 'https://example.invalid/q', authentication: 'genericCredentialType', genericAuthType: 'httpQueryAuth', options: {} })};\n`);
  writeFileSync(join(w2Dir, 'nodes', M2, 'credentials.ts'), `export default { httpQueryAuth: '${C2}' };\n`);
  editJson(join(w2Dir, 'metadata.json'), (m) => ({ ...m, connections: { [M1]: { main: [[{ node: M2, type: 'main', index: 0 }]] } } }));
  const env = { SMOKE_API_TOKEN: SECRET2, SMOKE_PROJECT_KEY_TOKEN: SECRET3 };
  const p = await plan(P1, [], env);
  check('plan: create credential + create workflow, nothing else', p.changes.length === 2 && p.changes.some((c) => c.startsWith('create credentials Smoke Project Key')) && p.changes.some((c) => c.startsWith('create workflows Smoke Project')), p.changes.join('; ') || p.r.out);
  const a = await n8c(P1, ['apply', '-m', 'smoke-6-project', '--debug'], env);
  check('apply exits 0', a.code === 0, a.out);
  info(`writes: ${a.calls.filter((c) => !c.startsWith('GET')).join(' | ')}`);
  if (API === '3') check('3.x: projectId sent in both create bodies, no transfer call', (a.stderr.match(/"projectId": "/g) ?? []).length === 2 && !a.calls.some((c) => c.endsWith('/transfer')), a.calls.join(' | '));
  else check('2.x: each create is followed by PUT …/transfer', a.calls.filter((c) => c.endsWith('/transfer')).length === 2, a.calls.join(' | '));
  const creds = (await credentials()).filter((c) => c.name === 'Smoke Project Key');
  const wfs = (await workflows()).filter((w) => w.name === 'Smoke Project');
  check('exactly one copy of each on n8n', creds.length === 1 && wfs.length === 1, `credentials ${creds.length}, workflows ${wfs.length}`);
  const inProject = await all(`/workflows?projectId=${encodeURIComponent(personalProjectId)}`);
  check('the workflow is listed under n8nProjectId', inProject.some((w) => w.name === 'Smoke Project'));
  const wNow = wfs[0] ? await getWf(wfs[0].id) : undefined;
  check('Fetch is bound to the new credential', !!wNow && wNow.nodes.find((n) => n.name === 'Fetch')?.credentials?.httpQueryAuth?.id === creds[0]?.id);
  const p2 = await plan(P1, [], env);
  check('plan afterwards is clean', p2.changes.length === 0, p2.changes.join('; '));
  project = { C2, W2, wfId: wfs[0]?.id, credId: creds[0]?.id };
  // Back to the default project for the steps below. If the workflow did not make it,
  // create it without the move so the destroy step still has something to destroy.
  editJson(join(P1, 'n8c.config.json'), (c) => ({ ...c, n8nProjectId: '' }));
  if (!project.wfId) {
    await plan(P1, [], env);
    const retry = await n8c(P1, ['apply'], env);
    project.wfId = (await workflows()).find((w) => w.name === 'Smoke Project')?.id;
    info(`with n8nProjectId unset, creating "Smoke Project" ${retry.code === 0 && project.wfId ? 'worked' : 'failed too'}`);
  }
});

await step('plan --destroy archives a file-less workflow and deletes the credential; a second round deletes the workflow for good', async () => {
  if (!project?.wfId) { info('skipped: the project step did not create a workflow'); return; }
  rmSync(join(P1, 'n8c', 'workflows', project.W2), { recursive: true, force: true });
  rmSync(join(P1, 'n8c', 'credentials', project.C2), { recursive: true, force: true });
  const env = { SMOKE_API_TOKEN: SECRET2 };
  const p = await plan(P1, ['--destroy'], env);
  check('plan --destroy: delete workflow Smoke Project + delete credential Smoke Project Key', p.changes.length === 2 && p.changes.some((c) => c.startsWith('delete workflows Smoke Project')) && p.changes.some((c) => c.startsWith('delete credentials Smoke Project Key')), p.changes.join('; '));
  const a = await n8c(P1, ['apply', '--debug'], env);
  check('apply exits 0', a.code === 0, a.out);
  const w = await getWf(project.wfId).catch((e) => ({ error: e.status }));
  check('credential deleted on n8n', !(await credentials()).some((c) => c.id === project.credId));
  if (!HAS_ARCHIVE) {
    // n8n 2.0–2.14 have no archive endpoint (405): n8c must notice and delete for good, saying so.
    check('2.0–2.14: archive answers 405, n8c deletes the workflow permanently and warns', a.calls.includes(`POST /api/v1/workflows/${project.wfId}/archive`) && a.calls.includes(`DELETE /api/v1/workflows/${project.wfId}`) && w.error === 404 && /permanently deleted because this n8n has no archive endpoint/.test(a.out), JSON.stringify({ error: w.error, calls: a.calls.filter((c) => !c.startsWith('GET')) }));
    const p3 = await plan(P1, [], env);
    check('plan afterwards is clean, no orphans', p3.changes.length === 0 && !(p3.st?.orphans ?? []).length, `${p3.changes.join('; ')} orphans=${JSON.stringify(p3.st?.orphans)}`);
    return;
  }
  check('workflow archived on n8n via POST …/archive', a.calls.includes(`POST /api/v1/workflows/${project.wfId}/archive`) && w.isArchived === true, JSON.stringify({ isArchived: w.isArchived, error: w.error, calls: a.calls.filter((c) => !c.startsWith('GET')) }));
  const p2 = await plan(P1, ['--destroy'], env);
  check('second plan --destroy: delete the archived workflow', p2.changes.length === 1 && /^delete workflows Smoke Project.* archived$/.test(p2.changes[0]), p2.changes.join('; '));
  const a2 = await n8c(P1, ['apply', '--debug'], env);
  const gone = await getWf(project.wfId).then(() => false, (e) => e.status === 404);
  check('second apply deletes it permanently (DELETE, then GET answers 404)', a2.code === 0 && a2.calls.includes(`DELETE /api/v1/workflows/${project.wfId}`) && gone, a2.calls.filter((c) => !c.startsWith('GET')).join(' | '));
  const p3 = await plan(P1, [], env);
  check('plan afterwards is clean, no orphans', p3.changes.length === 0 && !(p3.st?.orphans ?? []).length, `${p3.changes.join('; ')} orphans=${JSON.stringify(p3.st?.orphans)}`);
});

await step('a second, empty project pulls from n8n and plans clean', async () => {
  // A description written in the n8n UI (simulated through the API), to see whether pull keeps it.
  const cur = await getWf(wf1.id);
  const NODE_KEYS = ['id', 'name', 'webhookId', 'disabled', 'notesInFlow', 'notes', 'type', 'typeVersion', 'executeOnce', 'alwaysOutputData', 'retryOnFail', 'maxTries', 'waitBetweenTries', 'continueOnFail', 'onError', 'position', 'parameters', 'credentials'];
  const nodes = cur.nodes.map((n) => Object.fromEntries(Object.entries(n).filter(([k]) => NODE_KEYS.includes(k))));
  const settings = Object.fromEntries(Object.entries(cur.settings ?? {}).filter(([k]) => ['executionOrder', 'timezone'].includes(k)));
  if (HAS_DESCRIPTION) await api('PUT', `/workflows/${wf1.id}`, { name: cur.name, description: 'Described in the n8n UI', nodes, connections: cur.connections, settings });
  info(`n8n description before the pull: ${JSON.stringify((await getWf(wf1.id)).description)}`);
  const P2 = join(RUN_DIR, 'clone'); mkdirSync(P2);
  await n8c(P2, ['init']);
  editJson(join(P2, 'n8c.config.json'), (c) => ({ ...c, n8nVersion: API }));
  const pl = await n8c(P2, ['pull', '-y']);
  check('pull into an empty project exits 0', pl.code === 0, pl.out);
  const files = tree(join(P2, 'n8c'));
  log(`pulled files: ${files.join(', ')}`);
  check('pull wrote the workflow, the credential and n8c.types.ts', files.some((f) => f.startsWith('workflows/')) && files.some((f) => f.startsWith('credentials/')) && files.includes('n8c.types.ts'), files.join(', '));
  const p = await plan(P2);
  const wfChanges = p.st ? p.st.resources.filter((r) => r.kind === 'workflows' && r.action !== 'noop').map(describe) : ['(no state written)'];
  check('plan right after pull: no workflow changes', p.r.code === 0 && wfChanges.length === 0, wfChanges.join('; ') || p.r.out);
  info(`plan right after pull, every row that is not a noop: ${p.changes.join('; ') || 'none'}`);
  if (HAS_DESCRIPTION) check('pull kept the description written in the n8n UI, in metadata.json', grepTree(join(P2, 'n8c', 'workflows'), 'Described in the n8n UI').some((f) => f.endsWith('/metadata.json')), `files: ${grepTree(join(P2, 'n8c', 'workflows'), 'Described in the n8n UI').join(', ')}`);
  // Deploy an unrelated change from the pulled project: n8n's description must survive it.
  // The workflow that holds Call API's URL (Smoke Main), not merely the first folder: other
  // workflows exist by now, and folder names are random UUIDs.
  const wfFile = files.find((f) => f.startsWith('workflows/') && f.endsWith('/apply.ts') && readFileSync(join(P2, 'n8c', f), 'utf8').includes('https://example.invalid/ping'));
  const abs = join(P2, 'n8c', wfFile);
  writeFileSync(abs, readFileSync(abs, 'utf8').replace('https://example.invalid/ping', 'https://example.invalid/ping-from-clone'));
  const p2 = await plan(P2);
  const a = await n8c(P2, ['apply']);
  const w = await getWf(wf1.id);
  check('an unrelated change deployed from the pulled project reaches n8n', a.code === 0 && w.nodes.find((n) => n.name === 'Call API')?.parameters?.url === 'https://example.invalid/ping-from-clone', `${p2.changes.join('; ')} | ${a.code ? a.out : w.nodes.find((n) => n.name === 'Call API')?.parameters?.url}`);
  if (HAS_DESCRIPTION) check('…and leaves the description written in the n8n UI in place', /^Described in the n8n UI/.test(w.description ?? ''), JSON.stringify(w.description));
});

await step('a wrong API key fails loudly', async () => {
  const p = await n8c(P1, ['plan'], { N8N_API_KEY: 'not-a-real-key', SMOKE_API_TOKEN: SECRET2, SMOKE_PROJECT_KEY_TOKEN: SECRET3 });
  check('plan exits non-zero and reports 401', p.code !== 0 && /401/.test(p.out), p.out);
});

finish();

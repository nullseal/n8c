import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MCP_TOOLS, toolArgv, handleMessage, type ToolRunner } from '../src/mcp/protocol.ts';
import { splitLines, spawnCliRunner, makeLineHandler } from '../src/mcp/server.ts';

const okRunner = async (argv: string[]) => ({ text: 'ran: ' + argv.join(' '), ok: true });

test('the tool set is exactly the sanctioned loop — never drop, never force', () => {
  assert.deepEqual(MCP_TOOLS.map((t) => t.name).sort(),
    ['n8c_apply', 'n8c_list', 'n8c_plan', 'n8c_pull', 'n8c_restore']);
  for (const t of MCP_TOOLS) {
    const props = JSON.stringify(t.inputSchema);
    assert.ok(!props.includes('force') && !props.includes('no_verify') && !props.includes('noVerify'),
      `${t.name} must not offer a gate-bypass parameter`);
  }
});

test('toolArgv maps tools to CLI argv, always with --pipe', () => {
  assert.deepEqual(toolArgv('n8c_plan', {}), ['plan', '--pipe']);
  assert.deepEqual(toolArgv('n8c_plan', { destroy: true, env: 'prod' }), ['plan', '--destroy', '-e', 'prod', '--pipe']);
  assert.deepEqual(toolArgv('n8c_pull', {}), ['pull', '-y', '--pipe'], 'pull is non-interactive over MCP');
  assert.deepEqual(toolArgv('n8c_apply', { message: 'ship it' }), ['apply', '-m', 'ship it', '--pipe']);
  assert.deepEqual(toolArgv('n8c_list', { full: true }), ['list', '--full', '--pipe']);
  assert.deepEqual(toolArgv('n8c_restore', { generation: 'abc123', apply: true }), ['restore', 'abc123', '--apply', '--pipe']);
  assert.throws(() => toolArgv('n8c_drop', {}), /unknown tool/);
  assert.throws(() => toolArgv('n8c_restore', {}), /generation/, 'restore requires a generation ref');
  assert.throws(() => toolArgv('n8c_restore', { generation: '--force' }), /must not start with/,
    'a flag-shaped ref must not reach argv as a positional — commander would parse it as a flag');
  // Unknown args are inert by allowlist: toolArgv only ever reads the specific
  // keys it knows about, so passing force/noVerify/destroy at n8c_apply (which
  // has no such tool parameters) produces the exact same argv as {}.
  assert.deepEqual(toolArgv('n8c_apply', { force: true, noVerify: true, destroy: true } as any), ['apply', '--pipe']);
});

test('initialize → capabilities+serverInfo; notification → undefined; ping → {}', async () => {
  const init = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } }, okRunner, '0.2.0') as any;
  assert.equal(init.jsonrpc, '2.0'); assert.equal(init.id, 1);
  assert.equal(init.result.serverInfo.name, 'n8c');
  assert.equal(init.result.serverInfo.version, '0.2.0');
  assert.ok(init.result.capabilities.tools, 'declares the tools capability');
  assert.equal(await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, okRunner, '0.2.0'), undefined);
  const pong = await handleMessage({ jsonrpc: '2.0', id: 2, method: 'ping' }, okRunner, '0.2.0') as any;
  assert.deepEqual(pong.result, {});
});

test('tools/list returns the tool defs; tools/call runs and wraps output', async () => {
  const list = await handleMessage({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, okRunner, '0.2.0') as any;
  assert.equal(list.result.tools.length, 5);
  const call = await handleMessage({ jsonrpc: '2.0', id: 4, method: 'tools/call',
    params: { name: 'n8c_plan', arguments: {} } }, okRunner, '0.2.0') as any;
  assert.deepEqual(call.result.content, [{ type: 'text', text: 'ran: plan --pipe' }]);
  assert.equal(call.result.isError, undefined);
});

test('a failed CLI run comes back as isError, not a protocol error', async () => {
  const failRunner = async () => ({ text: 'boom', ok: false });
  const call = await handleMessage({ jsonrpc: '2.0', id: 5, method: 'tools/call',
    params: { name: 'n8c_apply', arguments: {} } }, failRunner, '0.2.0') as any;
  assert.equal(call.result.isError, true);
  assert.equal(call.result.content[0].text, 'boom');
});

test('unknown method → -32601; unknown tool → isError result', async () => {
  const bad = await handleMessage({ jsonrpc: '2.0', id: 6, method: 'nope' }, okRunner, '0.2.0') as any;
  assert.equal(bad.error.code, -32601);
  const badTool = await handleMessage({ jsonrpc: '2.0', id: 7, method: 'tools/call',
    params: { name: 'n8c_drop', arguments: {} } }, okRunner, '0.2.0') as any;
  assert.equal(badTool.result.isError, true, 'tool-level failure is a result, per MCP spec');
});

test('splitLines: newline-delimited framing across chunk boundaries', () => {
  const buf = { rest: '' };
  assert.deepEqual(splitLines(buf, '{"a":1}\n{"b"'), ['{"a":1}']);
  assert.deepEqual(splitLines(buf, ':2}\n'), ['{"b":2}']);
  assert.deepEqual(splitLines(buf, '\n\n'), [], 'blank lines are skipped');
});

test('spawnCliRunner surfaces exit code as ok/!ok and captures both streams', async () => {
  // Use node itself as the "CLI": a script that echoes argv, writes stderr, exits per argv.
  // Under `-e` there is no script-path slot in argv (unlike a real file), so the
  // args-after-`--` start at index 1, not 2; filter a leading `--` defensively
  // in case a Node version forwards the separator literally.
  const script = 'const a = process.argv.slice(1).filter((x, i) => !(i === 0 && x === "--")); process.stdout.write(a.join(" ")); process.stderr.write("E"); process.exit(a.includes("fail") ? 1 : 0);';
  const run = spawnCliRunner('--eval:' + script); // test hook, see implementation
  const ok = await run(['plan', '--pipe']);
  assert.ok(ok.ok); assert.ok(ok.text.includes('plan --pipe')); assert.ok(ok.text.includes('E'), 'stderr captured');
  const bad = await run(['fail']);
  assert.equal(bad.ok, false);
});

test('makeLineHandler serializes tool calls: second call starts only after first ends', async () => {
  // Two lines land "at once" (both enqueued before either resolves) — the first
  // runner invocation is slow, the second is instant. If handling were concurrent
  // (the pre-fix behaviour), start2 would land before end1. Queued handling must
  // keep them in strict start1/end1/start2/end2 order regardless of which is slower.
  const order: string[] = [];
  let calls = 0;
  const run: ToolRunner = async () => {
    calls += 1;
    const id = calls;
    order.push('start' + id);
    if (id === 1) await new Promise(function (r) { setTimeout(r, 20); });
    order.push('end' + id);
    return { text: 'ok', ok: true };
  };
  const line = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'n8c_plan', arguments: {} } });
  // Silence the real stdout write inside the handler — only the ordering matters here.
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (function () { return true; }) as typeof process.stdout.write;
  try {
    const enqueue = makeLineHandler(run, '0.3.0');
    const p1 = enqueue(line);
    const p2 = enqueue(line);
    await p2;
    await p1;
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.deepEqual(order, ['start1', 'end1', 'start2', 'end2']);
});

test('makeLineHandler continues after a handler rejection — second message still executes', async () => {
  // First runner throws, second succeeds. Without rejection handling, the thrown
  // error becomes the stored queue, and the second enqueue() chains .then() onto
  // a rejected promise, silently skipping it forever. With .catch() in the queue
  // chain, the rejection is swallowed and the next handler still runs.
  const order: string[] = [];
  let calls = 0;
  const run: ToolRunner = async () => {
    calls += 1;
    order.push('runner' + calls);
    if (calls === 1) throw new Error('first call intentionally fails');
    return { text: 'ok', ok: true };
  };
  const line = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'n8c_plan', arguments: {} } });
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (function () { return true; }) as typeof process.stdout.write;
  try {
    const enqueue = makeLineHandler(run, '0.3.0');
    await enqueue(line); // first call rejects
    await enqueue(line); // second call should still run
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.deepEqual(order, ['runner1', 'runner2'], 'both runners invoked despite first rejection');
});

test('spawnCliRunner does not leave the child stdin as a dangling open pipe', async () => {
  // Behavioural check, not a mock: with stdio[0] === 'ignore' the child's stdin
  // is /dev/null, so a read sees EOF immediately and 'end' fires right away. If
  // the fix regressed to the spawn default (an unattached pipe), 'end' would
  // never fire and this test would time out instead of resolving with 'ended'.
  const script = "process.stdin.once('end', function () { process.stdout.write('ended'); process.exit(0); }); process.stdin.resume();";
  const run = spawnCliRunner('--eval:' + script);
  const res = await run([]);
  assert.ok(res.ok);
  assert.equal(res.text, 'ended');
});

test('end-to-end: closing stdin right after a tools/call line still yields its response (regression for Fix 1)', { timeout: 20000 }, async () => {
  // Spawns the REAL server (not the in-process handler) so the regression is
  // caught at the level it actually happened: the old `process.stdin.on('end',
  // () => process.exit(0))` raced the in-flight spawned CLI call. `n8c_list` is
  // read-only and safe to run without any n8n/DB config present — it may well
  // exit non-zero (no config in this repo checkout), which is fine; the point is
  // that a RESPONSE for it arrives at all, before the server process exits.
  const cliPath = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const child = spawn(process.execPath, [cliPath, 'mcp'], { stdio: ['pipe', 'pipe', 'pipe'] });

  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const stderrChunks: string[] = [];
  child.stderr.on('data', (d) => { stderrChunks.push(String(d)); });

  try {
    const init = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    const call = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'n8c_list', arguments: {} } });
    child.stdin.write(init + '\n' + call + '\n');
    child.stdin.end(); // EOF immediately after writing — the exact race Fix 1 closes

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('server did not exit — check for a hang: ' + stderrChunks.join(''))), 15000);
      child.on('close', () => { clearTimeout(timer); resolve(undefined); });
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
    });

    const lines = out.split('\n').filter((l) => l.trim() !== '');
    const messages = lines.map((l) => JSON.parse(l));
    const initResp = messages.find((m) => m.id === 1) as any;
    const callResp = messages.find((m) => m.id === 2) as any;
    assert.ok(initResp, 'initialize response arrived');
    assert.ok(callResp, 'tools/call response arrived even though stdin closed right after it was written');
    assert.ok(callResp.result, 'result present (isError acceptable — n8c_list may fail without config)');
  } finally {
    if (child.exitCode === null) child.kill();
  }
});

test('spawnCliRunner resolves { ok: false } with the error text when the child cannot be spawned', async () => {
  const realExec = process.execPath;
  (process as any).execPath = '/nonexistent/node-binary';
  try {
    const res = await spawnCliRunner('whatever.js')([]);
    assert.equal(res.ok, false);
    assert.match(res.text, /ENOENT/);
  } finally { (process as any).execPath = realExec; }
});

test('makeLineHandler survives a throwing stdout write — the next message is still processed', async () => {
  let calls = 0;
  const run: ToolRunner = async () => { calls += 1; return { text: 'ok', ok: true }; };
  const mk = (id: number) => JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'n8c_plan', arguments: {} } });
  const originalWrite = process.stdout.write.bind(process.stdout);
  // Only count this test's own JSON-RPC responses (ids 9101/9102); ignore unrelated stdout writes.
  const ours: number[] = [];
  process.stdout.write = (function (chunk: unknown, ...rest: unknown[]) {
    const m = /"id":(910[12])\b/.exec(String(chunk));
    if (!m) return (originalWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
    ours.push(Number(m[1]));
    if (ours.length === 1) throw new Error('EPIPE');
    return true;
  }) as typeof process.stdout.write;
  try {
    const enqueue = makeLineHandler(run, '0.3.0');
    await enqueue(mk(9101)); // write throws → swallowed by the queue's catch
    await enqueue(mk(9102));
  } finally { process.stdout.write = originalWrite; }
  assert.equal(calls, 2);
  assert.deepEqual(ours, [9101, 9102], 'second message reached stdout after the first write threw');
});

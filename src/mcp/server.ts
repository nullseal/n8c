import { spawn } from 'node:child_process';
import { handleMessage, type ToolRunner } from './protocol.ts';

// MCP stdio framing: one JSON-RPC message per line. Chunks can split messages, so
// keep the unterminated tail in `buf.rest` between reads.
export function splitLines(buf: { rest: string }, chunk: string): string[] {
  const parts = (buf.rest + chunk).split('\n');
  buf.rest = parts.pop() ?? '';
  return parts.filter((l) => l.trim() !== '');
}

// Each tool call spawns n8c's OWN CLI — behaviour parity by construction.
// `--eval:` prefix is a test hook: run an inline script instead of a file.
export function spawnCliRunner(cliPath: string): ToolRunner {
  return (argv) => new Promise((resolve) => {
    const args = cliPath.startsWith('--eval:')
      ? ['--input-type=module', '-e', cliPath.slice('--eval:'.length), '--', ...argv]
      : [cliPath, ...argv];
    // stdin: 'ignore' — no tool call ever writes to the child's stdin, and an
    // unattached pipe (the spawn default) stays open forever with no timeout;
    // if any CLI path ever tried to read it, the tool call would hang for good.
    const child = spawn(process.execPath, args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    child.stdout.on('data', (d) => { text += d; });
    child.stderr.on('data', (d) => { text += d; });
    child.on('close', (code) => resolve({ text: text || `(exit ${code})`, ok: code === 0 }));
    child.on('error', (e) => resolve({ text: String(e?.message ?? e), ok: false }));
  });
}

// One line in, one line handled at a time. Without this, two `tools/call` lines
// arriving in the same chunk (or in back-to-back chunks) would run concurrently:
// two `apply` runs would race on n8n's DB/state file (apply mutates production),
// and two stdout writes above PIPE_BUF could interleave at the kernel level and
// desync the reader's line framing. A promise chain enqueues each line's work
// after the previous one settles, so ordering is guaranteed regardless of how
// the chunks split. Pulled out of `startMcpServer` (rather than inlined in the
// `data` handler) so a test can enqueue lines directly and observe start/end order.
export function makeLineHandler(run: ToolRunner, version: string): (line: string) => Promise<void> {
  let queue: Promise<void> = Promise.resolve();
  return function enqueue(line: string): Promise<void> {
    queue = queue.then(async () => {
      let msg: unknown;
      try { msg = JSON.parse(line); } catch { return; } // not JSON — skip, never crash the transport
      const res = await handleMessage(msg, run, version);
      if (res) process.stdout.write(JSON.stringify(res) + '\n');
    }).catch(() => {
      // One bad message must not wedge the transport; the failure was already
      // reported by handleMessage or is unreportable (e.g. stdout write failed).
      // Swallow it so the next enqueue() chains onto a settled promise.
    });
    return queue;
  };
}

export function startMcpServer(opts: { version: string; cliPath: string }): void {
  const run = spawnCliRunner(opts.cliPath);
  const buf = { rest: '' };
  const enqueue = makeLineHandler(run, opts.version);
  // Track the queue tail so 'end' can wait for in-flight work: stdin EOF fires
  // as soon as the client closes its write side, which can happen right after
  // writing a tools/call line — a spawned `apply` may still be running (and may
  // have already mutated n8n) when that happens. Exiting immediately would drop
  // the response the client is waiting for. `enqueue` already returns the queue
  // promise, so chaining `tail` onto it costs nothing on the happy path.
  let tail: Promise<void> = Promise.resolve();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    for (const line of splitLines(buf, chunk)) tail = enqueue(line);
  });
  process.stdin.on('end', () => { tail.finally(() => process.exit(0)); });
}

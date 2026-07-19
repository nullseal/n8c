import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = resolve(fileURLToPath(new URL('../src/cli.ts', import.meta.url)));

// Regression: an npm bin is a SYMLINK to cli.ts. main() must still run when the
// CLI is invoked through a symlink (process.argv[1] is the symlink, not the
// module). A naive `file://${argv[1]}` entry-point check silently skipped main
// and the process exited 0 doing nothing.
test('CLI runs main() when invoked through a symlink', () => {
  const dir = mkdtempSync(join(tmpdir(), 'n8c-bin-'));
  try {
    const link = join(dir, 'n8c-link.ts');
    symlinkSync(cli, link);
    writeFileSync(join(dir, 'n8c.config.json'), JSON.stringify({ root: 'n8c', defaultEnv: 'default' }));

    const out = execFileSync('node', [link, 'create', 'prompt', '--name=greet', '--key=greet_sys'], {
      cwd: dir, encoding: 'utf8',
    });
    assert.match(out, /created prompt/);
    const ids = readdirSync(join(dir, 'n8c', 'prompts'));
    assert.equal(ids.length, 1);
    assert.ok(existsSync(join(dir, 'n8c', 'prompts', ids[0], 'apply.ts')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

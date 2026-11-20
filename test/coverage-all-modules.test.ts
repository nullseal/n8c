import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The coverage report (c8, run without --all) lists only modules loaded during
// the run, so a module no test imports is silently missing from it
// (src/store/mongo.ts was). Importing every source file makes such a module show
// up at its true coverage.
const SRC = fileURLToPath(new URL('../src/', import.meta.url));
function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return tsFiles(p);
    return p.endsWith('.ts') && !p.endsWith('.d.ts') ? [p] : [];
  });
}

test('every src module loads, so the coverage report cannot hide an untested one', async () => {
  const files = tsFiles(SRC);
  assert.ok(files.includes(join(SRC, 'store', 'mongo.ts')), 'walks the whole src tree');
  for (const f of files) await import(pathToFileURL(f).href);
});

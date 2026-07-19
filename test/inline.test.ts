import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inlineUnit } from '../src/build/inline.ts';

function unit(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'n8c-unit-'));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

test('inlines a named helper and strips types + exports', () => {
  const dir = unit({
    'mystuff1.ts': 'export const TAX: number = 2;\nexport function dbl(n: number): number { return n * 2; }\n',
    'code.ts': "import { TAX, dbl } from './mystuff1.ts';\nconst out = dbl($json.n) + TAX;\nreturn [{ json: { out } }];\n",
  });
  try {
    const js = inlineUnit(dir);
    assert.ok(!/(^|\n)\s*import\b/.test(js), 'no import statements remain');
    assert.ok(!/(^|\n)\s*export\b/.test(js), 'no export keywords remain');
    assert.ok(!/:\s*number/.test(js), 'types stripped');
    assert.ok(js.includes('function dbl'));
    assert.ok(js.indexOf('function dbl') < js.indexOf('const out'), 'helper before entry body');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('resolves a transitive helper chain in dependency order', () => {
  const dir = unit({
    'a.ts': 'export const A = 1;\n',
    'b.ts': "import { A } from './a.ts';\nexport const B = A + 1;\n",
    'code.ts': "import { B } from './b.ts';\nreturn [{ json: { B } }];\n",
  });
  try {
    const js = inlineUnit(dir);
    assert.ok(js.indexOf('const A') < js.indexOf('const B'), 'a before b');
    assert.ok(js.indexOf('const B') < js.indexOf('return ['), 'helpers before entry');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('throws on a non-relative import', () => {
  const dir = unit({ 'code.ts': "import _ from 'lodash';\nreturn [];\n" });
  try { assert.throws(() => inlineUnit(dir), /cannot import "lodash"/); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

test('throws on default export in a helper (reached via a named import)', () => {
  const dir = unit({ 'h.ts': 'export const x = 1;\nexport default 5;\n', 'code.ts': "import { x } from './h.ts';\nreturn [x];\n" });
  try { assert.throws(() => inlineUnit(dir), /use named exports/); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

test('throws on a default import from a helper', () => {
  const dir = unit({ 'h.ts': 'export const x = 1;\n', 'code.ts': "import h from './h.ts';\nreturn [h];\n" });
  try { assert.throws(() => inlineUnit(dir), /use named imports/); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

test('throws on an import cycle', () => {
  const dir = unit({
    'a.ts': "import { B } from './b.ts';\nexport const A = B;\n",
    'b.ts': "import { A } from './a.ts';\nexport const B = A;\n",
    'code.ts': "import { A } from './a.ts';\nreturn [A];\n",
  });
  try { assert.throws(() => inlineUnit(dir), /import cycle/); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

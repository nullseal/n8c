import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
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

test('resolveDep: extensionless spec resolves to helper.ts', () => {
  const dir = unit({
    'helper.ts': 'export const K = 7;\n',
    'code.ts': "import { K } from './helper';\nreturn [{ json: { K } }];\n",
  });
  try {
    const js = inlineUnit(dir);
    assert.ok(js.includes('const K = 7'));
    assert.ok(js.includes('return [{ json: { K } }];'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('resolveDep: a spec that exists only without .ts is returned as-is (extensionless file is inlined)', () => {
  const dir = unit({
    'plain': 'export const P = 1;\n',
    'code.ts': "import { P } from './plain';\nreturn [{ json: { P } }];\n",
  });
  try {
    const js = inlineUnit(dir);
    assert.ok(js.includes('const P = 1'), 'the extensionless file was inlined');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('resolveDep: an unresolvable spec throws cannot resolve import', () => {
  const dir = unit({ 'code.ts': "import { X } from './nope';\nreturn [];\n" });
  try {
    assert.throws(() => inlineUnit(dir), /cannot resolve import "\.\/nope"/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a side-effect import in a helper is not consumed and throws unsupported import/export form', () => {
  // IMPORT_RE requires `from`, so `import './side.ts';` is never consumed. At helper module
  // scope it survives type stripping (no wrapper), reaching the final leftover-import check.
  const dir = unit({
    'helper.ts': "import './side.ts';\nexport const H = 1;\n",
    'code.ts': "import { H } from './helper.ts';\nreturn [{ json: { H } }];\n",
  });
  try {
    assert.throws(() => inlineUnit(dir), /unsupported import\/export form/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a unit directory without code.ts throws code.ts not found', () => {
  const dir = unit({ 'other.ts': 'export const X = 1;\n' });
  try {
    assert.throws(() => inlineUnit(dir), /code\.ts not found/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a helper imported by two modules (diamond) is inlined exactly once', () => {
  const dir = unit({
    'shared.ts': 'export const SHARED = 7;\n',
    'a.ts': "import { SHARED } from './shared.ts';\nexport const A = SHARED + 1;\n",
    'b.ts': "import { SHARED } from './shared.ts';\nexport const B = SHARED + 2;\n",
    'code.ts': "import { A } from './a.ts';\nimport { B } from './b.ts';\nreturn [{ json: { A, B } }];\n",
  });
  try {
    const js = inlineUnit(dir);
    assert.equal(js.split('const SHARED = 7').length - 1, 1, 'shared helper appears once');
    assert.ok(js.includes('const A =') && js.includes('const B ='));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('inlining a unit prints no stripTypeScriptTypes experimental warning', () => {
  const dir = unit({ 'code.ts': 'const n: number = 1;\nreturn [{ json: { n } }];\n' });
  try {
    // A warning fires once per process, so check a fresh one.
    const script = `import { inlineUnit } from ${JSON.stringify(new URL('../src/build/inline.ts', import.meta.url).href)}; process.stdout.write(inlineUnit(process.argv[1]));`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script, dir], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes('return'), 'inlined output produced');
    assert.ok(!/stripTypeScriptTypes|ExperimentalWarning/.test(r.stderr), r.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

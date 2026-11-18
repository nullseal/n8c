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

// Inline a unit whose only file is a code.ts with this body. A plain-JS body with no
// imports inlines to itself, byte for byte: nothing in it is cut or rewritten.
function inlineBody(body: string): string {
  const dir = unit({ 'code.ts': body });
  try { return inlineUnit(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('import text in a comment is not an import, and the comment is kept byte-for-byte', () => {
  const line = "// import { pick } from 'lodash'\nconst a = 1;\nreturn [{ json: { a } }];\n";
  assert.equal(inlineBody(line), line);
  const block = "/*\nimport { pick } from 'lodash'\nexport default pick\n*/\nreturn [];\n";
  assert.equal(inlineBody(block), block);
});

test('import/export lines inside a multi-line template literal are text, kept byte-for-byte', () => {
  const imp = 'const q = `SELECT 1\nimport data from somewhere`;\nreturn [{ json: { q } }];\n';
  assert.equal(inlineBody(imp), imp);
  const exp = 'const q = `SELECT 1\nexport default somewhere`;\nreturn [{ json: { q } }];\n';
  assert.equal(inlineBody(exp), exp);
  // An escaped backtick does not end the template, and an escaped \${ starts no expression.
  const esc = "const q = `a \\` import { x } from './nope' \\${ import { y } from './nope' }`;\nreturn [{ json: { q } }];\n";
  assert.equal(inlineBody(esc), esc);
});

test('import text inside a string literal is neither resolved nor cut out of the string', () => {
  const dq = "const s = \"import { x } from './nope'\";\nreturn [{ json: { s } }];\n";
  assert.equal(inlineBody(dq), dq);
  const escaped = "const t = 'it\\'s import { y } from \"./nope\"';\nreturn [{ json: { t } }];\n";
  assert.equal(inlineBody(escaped), escaped);
});

test('a ${…} expression inside a template is code: its comment, braces, string and nested template do not end it early', () => {
  // Template text with an import-like line follows each expression: ending one in the
  // wrong place would scan that text as code.
  const src = [
    'const n = 1;',
    "const q = `a ${ n /* ` */ } import { x } from './nope'",
    "${ [n].map((v) => { return { v }; }) } import { y } from './nope'",
    "${ `nested ${ \"`\" } template` } import { z } from './nope'",
    'import data from somewhere`;',
    'return [{ json: { q } }];',
    '',
  ].join('\n');
  assert.equal(inlineBody(src), src);
});

test('a ${…} expression is still code: a dynamic import at the start of a line inside one is a leftover', () => {
  const src = "const m = `${\nimport('./x.ts')\n}`;\nreturn [{ json: { m } }];\n";
  assert.throws(() => inlineBody(src), /unsupported import\/export form left after inlining/);
});

// Each head below holds ONE regex literal with a backtick in it, followed by a template with
// import-like text. Read as division instead, that backtick would open a template, so the
// real template's text would be scanned as code and the unit rejected.
const AFTER_REGEX = 'const q = `a\nimport data from somewhere`;\nreturn [{ json: { q } }];\n';

test('regex-literal rule: / starts a regex at the start, after an operator, ( [ , ! ? => ... or }, and after a keyword', () => {
  for (const head of [
    '/`/.test("");',
    'const r = /`/;',
    'const r = String(/`/);',
    'const r = [0, /`/];',
    'const r = [.../`/.source];',
    'const r = !/`/.test("");',
    'const r = true && /`/;',
    'const r = true ? /`/ : 0;',
    'const r = (s) => /`/.test(s);',
    'const r = typeof /`/;',
    'function r(s) { return /`/.test(s); }',
    'if (true) { }\n/`/.test("");',
    'const r = /[/`]/;',
    'const r = /[`/]/;',
    'const r = /\\/`/;',
  ]) {
    const src = head + '\n' + AFTER_REGEX;
    assert.equal(inlineBody(src), src, head);
  }
});

test('regex-literal rule: / after a name, a number, ), ], ++, -- or a property named like a keyword is division', () => {
  // Read as a regex instead, each head's / would run to the / inside the template,
  // hiding the template's opening backtick.
  const tail = ' const q = `a / b\nimport data from somewhere`;\nreturn [{ json: { q } }];\n';
  for (const head of [
    'let n = 4; const d = n / 2;',
    'const d = 4 / 2;',
    'const d = (4) / 2;',
    'const d = [4][0] / 2;',
    'let n = 4; const d = n++ / 2;',
    'let n = 4; const d = n-- / 2;',
    'const o = { in: 4 }; const d = o.in / 2;',
  ]) {
    const src = head + tail;
    assert.equal(inlineBody(src), src, head);
  }
});

test('regex-literal rule: a regex start with no closing / on its line is division after all', () => {
  // A / after } reads as a regex start; here the } ends an object literal that is divided.
  const src = 'const h = { valueOf: () => 4 } / 2, q = `a\nimport data from somewhere`;\nreturn [{ json: { h, q } }];\n';
  assert.equal(inlineBody(src), src);
});

test('known scanner limits: a regex right after ), or a division right after } or a variable named of, is misread and the valid unit is rejected', () => {
  for (const src of [
    'const s = "x";\nif (s) /`/.test(s);\nconst q = `a\nimport data from somewhere`;\nreturn [{ json: { q } }];\n',
    'const h = { valueOf: () => 4 } / 2, q = `a / b\nimport data from somewhere`;\nreturn [{ json: { h, q } }];\n',
    'let of = 4; const d = of / 2, q = `a / b\nimport data from somewhere`;\nreturn [{ json: { d, q } }];\n',
  ]) {
    assert.throws(() => inlineBody(src), /unsupported import\/export form left after inlining/, src);
  }
});

test('TypeScript around strings and templates: types, generics and a non-null ! before a division are scanned before stripping', () => {
  const dir = unit({
    'h.ts': 'export const H: number = 4;\n',
    'code.ts': [
      "import { H } from './h.ts';",
      "type Kind = 'import { k } from \"./nope\"' | `export ${string}`;",
      "const m = new Map<string, number>([['k', H]]);",
      "const half: number = m.get('k')! / 2; const q: string = `a / b",
      "import { pick } from 'lodash'`;",
      'return [{ json: { half, q } }];',
      '',
    ].join('\n'),
  });
  try {
    const js = inlineUnit(dir);
    assert.ok(js.includes("`a / b\nimport { pick } from 'lodash'`"), 'the template is kept byte-for-byte');
    assert.ok(js.startsWith('const H'), 'the helper is inlined first');
    assert.ok(!js.includes("'./h.ts'"), 'the real import is cut');
    assert.ok(!/:\s*(?:number|string)\b|Map</.test(js), 'types are stripped');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a helper keeps export-like text in its templates, strings and comments byte-for-byte; its real exports are still cut', () => {
  const tpl = '`\nexport default x\nexport const y = 1\nexport { a, b }\n`';
  const dir = unit({
    'h.ts': [
      '// export default nothing',
      `const T = ${tpl};`,
      'export const S = "export const q = 2";',
      'export function f(): string { return T + S; }',
      'export { T };',
      '',
    ].join('\n'),
    'code.ts': "import { T, f } from './h.ts';\nreturn [{ json: { t: T, f: f() } }];\n",
  });
  try {
    const js = inlineUnit(dir);
    assert.ok(js.includes(`const T = ${tpl};`), 'the template is kept byte-for-byte');
    assert.ok(js.includes('// export default nothing'), 'the comment is kept');
    assert.ok(js.includes('\nconst S = "export const q = 2";'), 'export cut from the declaration, string kept');
    assert.ok(js.includes('\nfunction f()'), 'export cut from the function');
    assert.ok(!js.includes('export { T }'), 'the export list is cut');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an unterminated template, comment or string does not hang the scanner: the type stripper rejects it', () => {
  for (const body of ['const q = `oops\nreturn [];\n', '/* oops\nreturn [];\n', 'const s = "oops\nreturn [];\n']) {
    assert.throws(() => inlineBody(body), { code: 'ERR_INVALID_TYPESCRIPT_SYNTAX' }, body);
  }
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

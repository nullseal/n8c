import '../quiet-warnings.ts'; // must precede the first stripTypeScriptTypes call — silences its experimental warning
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';

// Zero-dependency inliner: turn a `src/<unit>/code.ts` entry plus its relative
// helper modules into ONE self-contained JavaScript string suitable for an n8n
// Code node (which cannot import). Types are removed with the builtin
// module.stripTypeScriptTypes. Only a small, explicit subset is supported —
// anything outside it THROWS (fail loud) rather than emitting wrong code.

// The import/export handling is regex-based, so each regex runs on a code-only
// view of the text (codeOnly) and its matches are cut from the text by offset (cut).
const IMPORT_RE = /import\s+([^;'"]+?)\s+from\s+['"]([^'"]+)['"];?/dg;
const EXPORT_DECL = /(?<=^\s*)export\s+(?=(?:const|let|var|function|async\s+function|class)\b)/gm;
const EXPORT_LIST = /^\s*export\s*\{[^}]*\}\s*;?\s*$/gm;

// Tokens of the code-only scanner, each tried at the scan position (sticky).
const COMMENT = /\/\/.*|\/\*[\s\S]*?(?:\*\/|$)/y;
const STRING = /(["'])((?:\\(?:\r\n|[\s\S])|(?!\1)[^\\\n\r])*)(\1?)/y; // unterminated: ends at the line
const REGEX = /(\/)((?:\\.|\[(?:\\.|[^\]\\\n\r\u2028\u2029])*\]|[^\/[\\\n\r\u2028\u2029])+)(\/[\w$]*)/y;
const TEMPLATE_TEXT = /(?:[^`\\$]|\\[\s\S]?|\$(?!\{))*/y;
const TOKEN = /\s+|\.\.\.|\.?[\w$]+|\+\+|--|[\s\S]/y; // `.name` is a property, never a keyword
const REGEX_AFTER = /^(?:[(,=:[!&|?{};+\-*%<>~^]|\.\.\.|return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)?$/;

// The code-only view of `src` (TypeScript or JavaScript): comments, and the text
// inside string literals, regex literals and template literals, become spaces.
// Line breaks and the literals' own quotes, slashes and backticks stay, so every
// offset and line is the source's own. Import/export-like text in those places is
// then never parsed, cut or rejected, and stays byte-for-byte. `${…}` expressions
// are code, nested templates included.
//
// `/` is also division. It starts a regex literal at the start of the text, after
// an operator, a spread `...` or one of ( [ { } , ; : ? ! (not after ++ or --), or
// after a keyword such as return, typeof or case. After a name, a number, a
// property (`o.in`), `)`, `]` or a literal it is division; so is a regex start with
// no closing `/` on its line. A `!` right after a name, `)` or `]` is TypeScript's
// non-null assertion, so `x! / 2` stays division. Known limits (pinned by tests):
// a regex right after `)`, as in `if (ok) /re/.test(s)`, is read as division, so
// its body is scanned as code; a division right after `}` (an object literal) or
// after a variable named like one of those keywords (`of`) is read as a regex
// start, which blanks the text up to the next `/` on that line. Either misread can
// shift what the scanner takes for strings, templates and comments after it.
function codeOnly(src: string): string {
  let out = '';
  let i = 0;
  let prev = '';             // the last code token: decides whether a `/` starts a regex
  const open: number[] = []; // one entry per enclosing `${…}`: its `{`s not yet closed
  const take = (re: RegExp): RegExpExecArray | null => { re.lastIndex = i; return re.exec(src); };
  const keep = (n: number): void => { out += src.slice(i, i + n); i += n; };
  const blank = (n: number): void => { out += src.slice(i, i + n).replace(/[^\n\r\u2028\u2029]/g, ' '); i += n; };
  // From inside a template: blank its text up to its closing backtick or next `${`.
  const templateText = (): void => {
    blank(take(TEMPLATE_TEXT)[0].length);
    if (src[i] === '`') { keep(1); prev = '`'; }
    else if (i < src.length) { keep(2); open.push(0); prev = '{'; }
  };
  while (i < src.length) {
    const c = src[i];
    const comment = take(COMMENT);
    if (comment) { blank(comment[0].length); continue; }
    if (c === '`') { keep(1); templateText(); continue; }
    if (c === '}' && open.length) {
      if (open[open.length - 1] === 0) { open.pop(); keep(1); templateText(); continue; } // ends a `${…}`
      open[open.length - 1]--;
    } else if (c === '{' && open.length) open[open.length - 1]++;
    const lit = take(STRING) || (REGEX_AFTER.test(prev) ? take(REGEX) : null);
    if (lit) { keep(1); blank(lit[2].length); keep(lit[3].length); prev = lit[0]; continue; }
    const tok = take(TOKEN)[0];
    keep(tok.length);
    if (tok.trim() && (tok !== '!' || REGEX_AFTER.test(prev))) prev = tok;
  }
  return out;
}

// Cut every match of `re` in the code-only view out of the text, and out of the
// view too, so the two stay aligned for the next cut.
function cut(text: string, code: string, re: RegExp): [string, string] {
  let t = '';
  let c = '';
  let at = 0;
  for (const m of code.matchAll(re)) {
    t += text.slice(at, m.index);
    c += code.slice(at, m.index);
    at = m.index + m[0].length;
  }
  return [t + text.slice(at), c + code.slice(at)];
}

function resolveDep(fromDir: string, spec: string): string {
  const base = join(fromDir, spec);
  if (base.endsWith('.ts') && existsSync(base)) return base;
  if (existsSync(base + '.ts')) return base + '.ts';
  if (existsSync(base)) return base;
  throw new Error(`cannot resolve import "${spec}" from ${fromDir}`);
}

// Parse `import ... from '...'` statements in real code and validate the subset.
function parseImports(src: string, file: string): { spec: string }[] {
  const out: { spec: string }[] = [];
  for (const m of codeOnly(src).matchAll(IMPORT_RE)) {
    const clause = m[1].trim();
    const spec = src.slice(...m.indices[2]); // a string literal, blank in the view: read it from the source
    if (!spec.startsWith('.')) throw new Error(`unit import in ${file}: cannot import "${spec}" — n8n Code nodes have no imports`);
    if (!clause.startsWith('{')) throw new Error(`unit import in ${file}: use named imports (no default/namespace) for "${spec}"`);
    out.push({ spec });
  }
  return out;
}

function transformHelper(rawTs: string, file: string): string {
  let js = stripTypeScriptTypes(rawTs, { mode: 'strip' });
  let code = codeOnly(js);
  if (/^\s*export\s+default\b/m.test(code)) throw new Error(`helper ${file}: use named exports (no default)`);
  [js, code] = cut(js, code, IMPORT_RE);
  [js, code] = cut(js, code, EXPORT_DECL); // `export const x` → `const x`
  [js] = cut(js, code, EXPORT_LIST);       // `export { a, b };`
  return js.trim();
}

function transformEntry(rawTs: string): string {
  // The entry is an n8n Code-node BODY: it can use a top-level `return`, which
  // the TS parser rejects at module scope. Remove imports textually first, then
  // wrap the body in a function so type-stripping parses it, then unwrap.
  const [noImports] = cut(rawTs, codeOnly(rawTs), IMPORT_RE);
  const wrapped = 'async function __n8c_entry(){\n' + noImports + '\n}';
  const stripped = stripTypeScriptTypes(wrapped, { mode: 'strip' });
  const lines = stripped.split('\n');
  lines.shift(); // drop `async function __n8c_entry(){`
  lines.pop();   // drop the closing `}`
  return lines.join('\n').trim();
}

export function inlineUnit(unitDir: string): string {
  const entry = join(unitDir, 'code.ts');
  if (!existsSync(entry)) throw new Error(`unit ${unitDir}: code.ts not found`);

  const ordered: string[] = []; // helper files, dependency-first
  const visited = new Set<string>();

  const visit = (file: string, stack: string[]): void => {
    if (stack.includes(file)) throw new Error(`import cycle at ${file}`);
    if (visited.has(file)) return;
    const src = readFileSync(file, 'utf8');
    for (const imp of parseImports(src, file)) {
      visit(resolveDep(dirname(file), imp.spec), [...stack, file]);
    }
    visited.add(file);
    if (file !== entry) ordered.push(file);
  };
  visit(entry, []);

  const parts: string[] = [];
  for (const helper of ordered) parts.push(transformHelper(readFileSync(helper, 'utf8'), helper));
  parts.push(transformEntry(readFileSync(entry, 'utf8')));
  const result = parts.filter((p) => p.length).join('\n\n');

  const code = codeOnly(result);
  if (/(^|\n)\s*import\b/.test(code) || /(^|\n)\s*export\b/.test(code)) {
    throw new Error(`unit ${unitDir}: unsupported import/export form left after inlining`);
  }
  return result + '\n';
}

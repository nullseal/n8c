// Offset-preserving code-only scanner used by the inliner and by layout routing.

// Tokens of the code-only scanner, each tried at the scan position (sticky).
const COMMENT = /\/\/.*|\/\*[\s\S]*?(?:\*\/|$)/y;
const STRING = /(["'])((?:\\(?:\r\n|[\s\S])|(?!\1)[^\\\n\r])*)(\1?)/y; // unterminated: ends at the line
const REGEX = /(\/)((?:\\.|\[(?:\\.|[^\]\\\n\r\u2028\u2029])*\]|[^\/[\\\n\r\u2028\u2029])+)(\/[\w$]*)/y;
const TEMPLATE_TEXT = /(?:[^`\\$]|\\[\s\S]?|\$(?!\{))*/y;
const TOKEN = /\s+|\.\.\.|\.?[\w$]+|\+\+|--|[\s\S]/y; // `.name` is a property, never a keyword
const AFTER_PUNCT = /^(?:[(,=:[!&|?{};+\-*/%<>~^]|\.\.\.)?$/; // '' is the start of the text
const AFTER_KEYWORD = /^(?:return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/;
const regexAfter = (prev: string): boolean => AFTER_PUNCT.test(prev) || AFTER_KEYWORD.test(prev);

// The code-only view of `src` (TypeScript or JavaScript): comments, and the text
// inside string literals, regex literals and template literals, become spaces.
// Line breaks and the literals' own quotes, slashes and backticks stay, so every
// offset and line is the source's own. Import/export-like text in those places is
// then never parsed, cut or rejected, and stays byte-for-byte. `${…}` expressions
// are code, nested templates included.
//
// `/` is also division. It starts a regex literal at the start of the text, after
// an operator (division included: `a / /re/`), a spread `...` or one of ( [ { } , ; : ? !
// (not after ++ or --), or after a keyword such as return, typeof or case. After a name, a number, a
// property (`o.in`), `)`, `]` or a literal it is division; so is a regex start with
// no closing `/` on its line. A `!` right after a name, `)` or `]` is TypeScript's
// non-null assertion, so `x! / 2` stays division. Known limits (pinned by tests):
// a regex right after `)`, as in `if (ok) /re/.test(s)`, is read as division, so
// its body is scanned as code; a division right after `}` (an object literal) or
// after a variable named like one of those keywords (`of`) is read as a regex
// start, which blanks the text up to the next `/` on that line. Either misread can
// shift what the scanner takes for strings, templates and comments after it, and so
// can hide a later real import/export: inlineUnit's final parse check catches that.
export function codeOnly(src: string): string {
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
    const lit = take(STRING) || (regexAfter(prev) ? take(REGEX) : null);
    if (lit) { keep(1); blank(lit[2].length); keep(lit[3].length); prev = lit[0]; continue; }
    const tok = take(TOKEN)[0];
    keep(tok.length);
    if (tok.trim() && (tok !== '!' || regexAfter(prev))) prev = tok;
  }
  return out;
}

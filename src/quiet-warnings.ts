// Side-effect module: install a narrow filter that swallows ONLY two Node
// "experimental feature" warnings: node:sqlite's, and node:module's
// stripTypeScriptTypes (used to inline Code-node units). Imported before the
// code that triggers them, so the filter is in place first: node:sqlite warns when
// the module is evaluated (ESM runs imports in source order, each fully before the
// next), stripTypeScriptTypes warns on its first call. Every other warning still
// passes through unchanged.
const QUIET = [
  'SQLite is an experimental feature',
  'stripTypeScriptTypes is an experimental feature',
];
const prev = process.emitWarning.bind(process);
(process as any).emitWarning = (msg: any, ...rest: any[]) => {
  const text = typeof msg === 'string' ? msg : msg?.message;
  if (typeof text === 'string' && QUIET.some((q) => text.includes(q))) return;
  return (prev as any)(msg, ...rest);
};

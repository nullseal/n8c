// Side-effect module: install a narrow filter that swallows ONLY node:sqlite's
// "experimental feature" warning. Imported before `node:sqlite` so the filter is
// in place when that module is evaluated (ESM runs imports in source order, each
// fully before the next), which is when the warning fires. Every other warning
// still passes through unchanged.
const prev = process.emitWarning.bind(process);
(process as any).emitWarning = (msg: any, ...rest: any[]) => {
  const text = typeof msg === 'string' ? msg : msg?.message;
  if (typeof text === 'string' && text.includes('SQLite is an experimental feature')) return;
  return (prev as any)(msg, ...rest);
};

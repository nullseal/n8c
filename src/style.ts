// Minimal ANSI styling for CLI output. Disabled by default and enabled per run
// (see the `preAction` hook in cli.ts) UNLESS `--pipe`, a non-TTY stdout, or
// NO_COLOR is set — so piped / `--pipe` output stays raw and parseable.
let enabled = false;
export function setStyle(on: boolean): void { enabled = on; }
export function styleEnabled(): boolean { return enabled; }

const RESET = '\x1b[0m';
function wrap(code: string, s: string): string { return enabled && s ? `${code}${s}${RESET}` : s; }

export const hash = (s: string): string => wrap('\x1b[36m', s);   // cyan — content checksums
export const dim = (s: string): string => wrap('\x1b[2m', s);     // gray — muted / no-op text
export const info = (s: string): string => wrap('\x1b[34m', s);   // blue — sub-notes
export const active = (s: string): string => wrap('\x1b[32m', s); // green — active-version marker

// Colour a plan/node status word: new=green, changed=yellow, removed=red,
// identical=dim. Unknown words pass through uncoloured.
export function status(s: string): string {
  const code: Record<string, string> = { new: '\x1b[32m', changed: '\x1b[33m', removed: '\x1b[31m', identical: '\x1b[2m' };
  return wrap(code[s] ?? '', s);
}

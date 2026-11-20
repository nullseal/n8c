import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { inlineUnit } from '../build/inline.ts';

// Build every source unit under <cwd>/src/* that has metadata.json + code.ts:
// inline it into one JS blob, write dist/<unit>.js, and map the target nodeId to
// the built code so a workflow apply can inject it as parameters.jsCode.
export async function buildSources(cwd: string): Promise<{ codeByNode: Record<string, string>; units: string[] }> {
  const srcDir = join(cwd, 'src');
  const codeByNode: Record<string, string> = {};
  const units: string[] = [];
  if (!existsSync(srcDir)) return { codeByNode, units };

  for (const name of readdirSync(srcDir)) {
    const unitDir = join(srcDir, name);
    if (!statSync(unitDir).isDirectory()) continue;
    if (!existsSync(join(unitDir, 'metadata.json')) || !existsSync(join(unitDir, 'code.ts'))) continue;

    const meta = JSON.parse(readFileSync(join(unitDir, 'metadata.json'), 'utf8'));
    if (!meta.target) throw new Error(`src unit ${name}: metadata.target (nodeId) is required`);

    const built = inlineUnit(unitDir);
    const distDir = join(cwd, 'dist');
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, name + '.js'), built);
    codeByNode[meta.target] = built;
    units.push(name);
  }
  return { codeByNode, units };
}

// The restored workflow nodes whose code a src/<unit> replaces, as
// "<workflow> → <node>". `restore` brings back a generation's own copy of each
// node's code, but src/ is the repo's source and part of no generation, so plan and
// apply inline the unit's CURRENT build there. A node whose restored code already
// equals that build is left out: nothing differs.
export function unitOverrides(docs: { name: string; body: unknown }[], codeByNode: Record<string, string>): string[] {
  const out: string[] = [];
  for (const d of docs) {
    for (const n of (d.body as any).nodes ?? []) {
      const built = codeByNode[n.id];
      if (built !== undefined && built !== n.parameters?.jsCode) out.push(`${d.name} → ${n.name}`);
    }
  }
  return out;
}

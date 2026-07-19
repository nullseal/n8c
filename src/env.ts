import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

export function resolveEnvName(argv: string[], config: { defaultEnv?: string }): string {
  const flag = argv.find((a) => a.startsWith('--env='));
  if (flag) return flag.slice('--env='.length);
  return config.defaultEnv ?? 'default';
}

export function listEnvs(files: string[]): string[] {
  const names: string[] = [];
  for (const f of files) {
    if (f === '.env') names.push('default');
    else if (f.startsWith('.env.')) names.push(f.slice('.env.'.length));
  }
  return names;
}

export function loadEnv(dir: string, name: string): Record<string, string> {
  const file = name === 'default' ? '.env' : `.env.${name}`;
  try { return parseDotenv(readFileSync(join(dir, file), 'utf8')); }
  catch { return {}; }
}

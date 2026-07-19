import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from '../store/store.ts';
import { resolveCollections } from '../store/collections.ts';

// The full default config, written explicitly by `init` so every knob is visible.
const DEFAULT_CONFIG = {
  database: 'mongodb',
  root: 'n8c',
  defaultEnv: 'default',
  n8nProjectId: '', // '' = the API key's default project; set to scope to one n8n project
  collectionPrefix: 'n8c_',
  collections: resolveCollections(),
  credentials: { encrypted: true },
};

const ENV_TEMPLATE = [
  'N8N_BASE=',
  'N8N_API_KEY=',
  'MONGO_URI=',
  'MONGO_DB=',
  'N8C_CREDENTIAL_ENCRYPTION_KEY=',
  '',
].join('\n');

const GITIGNORE_BASE = ['.env', '.env.*', '!.env.example', 'dist/', '.states/'];

// Scaffold a project to use n8c. Idempotent: only creates what's missing.
// Returns the list of paths created or updated (relative to cwd).
export function initProject(cwd: string): string[] {
  const touched: string[] = [];
  const write = (rel: string, content: string) => { writeFileSync(join(cwd, rel), content); touched.push(rel); };

  // config
  const cfgPath = join(cwd, 'n8c.config.json');
  if (!existsSync(cfgPath)) write('n8c.config.json', JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n');

  // No directory skeleton: entity dirs (n8c/workflows/…) are created lazily by
  // `create`/`pull` (mkdir -p). init only writes config + env + gitignore.

  // env template (never clobber a real .env* with secrets)
  if (!existsSync(join(cwd, '.env.example'))) write('.env.example', ENV_TEMPLATE);
  const hasAnyEnv = ['.env', '.env.default', '.env.staging', '.env.production'].some((f) => existsSync(join(cwd, f)));
  if (!hasAnyEnv) write('.env', ENV_TEMPLATE);

  // gitignore: ignore only secrets (.env*) and build artifacts (dist/). The n8c
  // root IS committed — it holds the code-first source of truth (stable localIds
  // shared across envs/machines); credential apply.ts read secrets from
  // process.env, so no secret lives in a committed file. Append only.
  const giPath = join(cwd, '.gitignore');
  const existing = existsSync(giPath) ? readFileSync(giPath, 'utf8') : '';
  const wanted = [...GITIGNORE_BASE];
  const missing = wanted.filter((l) => !existing.split('\n').map((x) => x.trim()).includes(l));
  if (missing.length) { writeFileSync(giPath, (existing ? existing.replace(/\n*$/, '\n') : '') + missing.join('\n') + '\n'); touched.push('.gitignore'); }

  return touched;
}

// Run the DB half: reconcile indexes + report replica-set status.
export async function initDb(store: Store): Promise<{ replicaSet: boolean; indexes: string[] }> {
  return store.init();
}

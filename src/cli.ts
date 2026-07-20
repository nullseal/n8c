#!/usr/bin/env node
import { Command } from 'commander';
import { readFileSync, writeFileSync, realpathSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { buildContext } from './context.ts';
import { checksum } from './checksum.ts';
import { entityByKind } from './entities/index.ts';
import { listEntity } from './engine/list.ts';
import { pullEntity } from './engine/pull.ts';
import { exportVersion, exportDocs } from './engine/transfer.ts';
import { createEntity } from './engine/generate.ts';
import { initProject, initDb } from './engine/init.ts';
import { loadEnv } from './env.ts';
import { hash, status as styleStatus, active, dim, info, notice, ok, danger, setStyle } from './style.ts';
import { setDebug } from './debug.ts';

const GROUP_TO_KIND: Record<string, string> = { workflow: 'workflows', prompt: 'prompts', 'prompt-content': 'promptContents', credential: 'credentials' };
const KIND_TO_SINGULAR: Record<string, string> = { workflows: 'workflow', prompts: 'prompt', promptContents: 'prompt-content', credentials: 'credential' };
const MSG_MAX = 60;

// Tail of an apply line. `no changes` only when the content is identical to live
// (truly known). Otherwise the created versionId — or, on --dry, `(unknown)`:
// whether a new version is written depends on dedup against history, which a dry
// run does not compute (Terraform-style "known after apply"). The per-node lines
// still show exactly what differs.
export function renderApplyTail(status: string, versionId?: string): string {
  if (status === 'identical') return 'no changes';
  return versionId ?? '(unknown)';
}

// Print a plan/state as a Terraform-style summary (skip noops).
//   ~ workflow  MKD_ Main Chatbot   (load_prompts)
//   Plan: 0 to create, 6 to update, 0 to destroy.
const ACTION_SIGN: Record<string, string> = { create: '+', update: '~', delete: '-' };
const ACTION_STATUS: Record<string, string> = { create: 'new', update: 'changed', delete: 'removed' };
function printPlanSummary(state: { summary: any; resources: any[]; orphans?: any[] }): void {
  for (const r of state.resources) {
    if (r.action === 'noop') continue;
    const type = KIND_TO_SINGULAR[r.kind] ?? r.kind;
    const nodes = r.nodes?.length ? '  (' + r.nodes.map((n: any) => n.name).join(', ') + ')' : '';
    console.log(`  ${styleStatus(ACTION_STATUS[r.action])} ${ACTION_SIGN[r.action]} ${type}  ${r.name}${nodes}`);
  }
  const s = state.summary;
  console.log(`Plan: ${s.create} to create, ${s.update} to update, ${s.delete} to destroy.`);
  // Deleted-locally entities are never destroyed implicitly — say so loudly rather
  // than letting `plan` look like nothing happened.
  const orphans = state.orphans ?? [];
  if (orphans.length) {
    const one = orphans.length === 1;
    console.log(danger(`\n! ${orphans.length} ${one ? 'entity exists' : 'entities exist'} on n8n/in the DB but ${one ? 'no longer has a file' : 'no longer have files'}:`));
    for (const o of orphans) console.log(danger(`    ${KIND_TO_SINGULAR[o.kind] ?? o.kind}  ${o.name}`));
    console.log(dim(`  re-run with \`--destroy\` to plan ${one ? 'its' : 'their'} removal.`));
  }
}

// Print an apply result: one line per applied item (and per failure), then a
// summary. Items are looked up from the state's resources for kind/name/action.
function printApplied(state: { resources: any[]; applied: { ok: string[]; failed: { localId: string; error: string }[] } | null }): void {
  const a = state.applied; if (!a) return;
  const byId = new Map(state.resources.map((r) => [r.localId, r]));
  for (const localId of a.ok) {
    const r = byId.get(localId);
    const type = KIND_TO_SINGULAR[r?.kind] ?? r?.kind ?? '';
    const act = r?.action ?? 'applied';
    console.log(`  ${styleStatus(ACTION_STATUS[act] ?? 'changed')} ${ACTION_SIGN[act] ?? '~'} ${type}  ${r?.name ?? localId}`);
  }
  for (const f of a.failed) {
    const r = byId.get(f.localId);
    console.error(`  ${styleStatus('removed')} ✗ ${KIND_TO_SINGULAR[r?.kind] ?? ''} ${r?.name ?? f.localId} — ${f.error}`);
  }
  console.log(`Apply complete: ${a.ok.length} applied, ${a.failed.length} failed.`);
}


// True if the n8c root already holds entity files that a `pull` would overwrite or
// prune (so we should confirm before clobbering local edits). Empty/absent → false.
export function dirHasEntities(root: string): boolean {
  for (const kind of ['workflows', 'prompts', 'prompt-contents', 'credentials']) {
    const dir = join(root, kind);
    if (existsSync(dir) && readdirSync(dir).length > 0) return true;
  }
  return false;
}

// Loudly warn about hardcoded secrets found in exported workflow files — n8c/
// is committed, so an inline token would land in git.
function printSecretWarnings(warnings: string[]): void {
  if (!warnings.length) return;
  console.error(`  ⚠ possible hardcoded secret(s) in exported files (n8c/ is committed — scrub & rotate):`);
  for (const w of warnings) console.error(`    - ${w}`);
}

export interface GenerationMember { kind: string; checksum: string; }
export interface Generation { versionId: string; hash: string; kinds: string[]; members: GenerationMember[]; active: boolean; message?: string; }

// Resolve a generation reference: an exact versionId, or a unique generation-hash
// prefix — git-style, so a short hash aliases the (long) versionId.
export function resolveGenerationRef(gens: Generation[], rawRef: string): string {
  // `n8c list` prints `<hash>: <message>`, so a copy-paste easily carries the colon
  // (and stray whitespace) — accept those rather than failing to resolve.
  const ref = rawRef.trim().replace(/:+$/, '');
  const exact = gens.find((g) => g.versionId === ref);
  if (exact) return exact.versionId;
  const hits = gens.filter((g) => g.hash.startsWith(ref));
  if (hits.length === 1) return hits[0].versionId;
  if (hits.length > 1) {
    throw new Error(`ambiguous generation hash "${ref}" (${hits.length} matches):\n`
      + hits.map((h) => `    ${h.hash.slice(0, 12)}  ${h.versionId}${h.message ? '  ' + h.message : ''}`).join('\n')
      + `\n  use a longer prefix or the full versionId.`);
  }
  throw new Error(`no generation matching "${ref}" (see \`n8c list\`)`);
}

// Fold the per-kind versions into generations (releases): the versionId is the
// shared key an `apply` writes across every kind, so grouping by it shows one row
// per release with the kinds it touched.
//
// Each generation gets a short `hash` — the typable id you pass to `restore` /
// `drop`. It mixes the versionId in with the member checksums so it is UNIQUE per
// release: two generations can legitimately hold identical content (a pull, then an
// apply that changed nothing), and a purely content-addressed hash would collide and
// make the reference ambiguous. Newest-first.
export function groupByGeneration(perKind: { kind: string; versions: { versionId: string; isActive: boolean; message?: string; checksum: string }[] }[]): Generation[] {
  const gens = new Map<string, Generation>();
  for (const { kind, versions } of perKind) {
    for (const v of versions) {
      const g = gens.get(v.versionId) ?? { versionId: v.versionId, hash: '', kinds: [], members: [], active: false };
      if (!g.kinds.includes(kind)) g.kinds.push(kind);
      g.members.push({ kind, checksum: v.checksum });
      if (v.isActive) g.active = true;
      if (!g.message && v.message) g.message = v.message;
      gens.set(v.versionId, g);
    }
  }
  return [...gens.values()]
    .map((g) => ({ ...g, hash: checksum([g.versionId, ...g.members.map((m) => `${m.kind}:${m.checksum}`).sort()]) }))
    .sort((a, b) => (a.versionId < b.versionId ? 1 : a.versionId > b.versionId ? -1 : 0));
}

// Render one generation as two lines — the release, then what it contains:
//
//   * 17257ffa: update abc
//       credential b5051dc0 · prompt-content e1910a56 · prompt 0fde0b6a · workflow 17257ffa
//
// The generation hash leads (git-style) — it's the short id you pass to
// `restore` / `drop`. The indented row lists each kind with ITS own checksum, so a
// release is auditable at a glance. `--full` adds the versionId and untruncates
// every hash and the message.
export function renderGeneration(g: Generation, full: boolean): string {
  const short = (s: string) => (full ? s : s.slice(0, 8));
  let msg = g.message ?? '';
  if (!full && msg.length > MSG_MAX) msg = msg.slice(0, MSG_MAX - 1) + '…';
  const head = `${g.active ? active('*') : ' '} ${hash(short(g.hash))}${msg ? ': ' + msg : ''}`
    + (full ? ` ${dim(g.versionId)}` : '');
  const members = g.members
    .slice()
    .sort((a, b) => (KIND_TO_SINGULAR[a.kind] ?? a.kind).localeCompare(KIND_TO_SINGULAR[b.kind] ?? b.kind))
    .map((m) => `${dim(KIND_TO_SINGULAR[m.kind] ?? m.kind)} ${hash(short(m.checksum))}`);
  return `${head}\n    ${members.join(dim(' · '))}`;
}

// Write n8c/n8c.types.ts from the credential types this instance actually uses
// (live docs + whatever n8n can list), so the editor knows each credential's real
// `data` fields. Returns the file path.
async function writeTypesFile(store: any, ctx: any, root: string): Promise<string> {
  const { fetchCredentialTypes, renderTypesFile, renderTsconfig } = await import('./engine/types-gen.ts');
  const types = new Set<string>();
  for (const d of await store.getLive('credentials')) { const t = (d.body as any)?.type; if (t) types.add(String(t)); }
  try { for (const c of (await ctx.n8n?.listCredentials?.()) ?? []) if (c?.type) types.add(String(c.type)); } catch { /* not listable */ }

  const cwd = process.cwd();
  // Declaring `process` alongside @types/node fails with TS2403, so only ship the
  // ambient shim when the project has no Node types of its own.
  const hasNodeTypes = existsSync(join(cwd, 'node_modules', '@types', 'node'));
  const file = join(root, 'n8c.types.ts');
  writeFileSync(file, renderTypesFile(await fetchCredentialTypes(ctx, [...types]), { declareProcess: !hasNodeTypes }));

  // The entity files import with a `.ts` specifier, which needs
  // allowImportingTsExtensions — give the editor a tsconfig unless one exists.
  const tsconfig = join(cwd, 'tsconfig.json');
  if (!existsSync(tsconfig)) writeFileSync(tsconfig, renderTsconfig(root.slice(cwd.length + 1) || 'n8c'));
  return file;
}

// Every managed kind's version list (real kind keys), the input for generation
// grouping/resolution. prompt-content is skipped on backends that don't serve it.
async function readGenerations(store: any, ctx: any): Promise<{ kind: string; versions: any[] }[]> {
  const kinds = ['workflows', 'prompts', 'credentials', ...(ctx.promptContentsEnabled === false ? [] : ['promptContents'])];
  return Promise.all(kinds.map(async (kind) => ({ kind, versions: await listEntity(store, entityByKind[kind]) })));
}

function resolveRoot(cwd: string): string {
  let config: any = {};
  try { config = JSON.parse(readFileSync(join(cwd, 'n8c.config.json'), 'utf8')); } catch {}
  return join(cwd, config.root ?? 'n8c');
}

function pkgVersion(): string {
  try { return JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')).version; }
  catch { return '0.0.0'; }
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('n8c')
    .description('Code-first CLI to version n8n workflows, prompts and credentials in a database')
    .version(pkgVersion())
    .option('-e, --env <name>', 'environment (overrides config defaultEnv)')
    .option('--pipe', 'raw output — no color/style (for piping/parsing)')
    .option('--debug', 'log every n8n API call (secrets redacted) to stderr');

  const envOf = () => program.opts().env as string | undefined;

  // Enable color per run unless --pipe (anywhere on the line), a non-TTY
  // stdout, or NO_COLOR. Scanning argv keeps --pipe position-independent.
  program.hook('preAction', () => {
    setStyle(!!process.stdout.isTTY && !process.argv.includes('--pipe') && !process.env.NO_COLOR);
    setDebug(process.argv.includes('--debug'));
  });

  // --- init ---
  program.command('init')
    .description('scaffold the project (config/.env/gitignore) and reconcile DB indexes')
    .option('--project-only', 'only scaffold files, skip the DB setup')
    .option('--db-only', 'only reconcile DB indexes / check replica set')
    .action(async (opts) => {
      const cwd = process.cwd();
      if (!opts.dbOnly) {
        const touched = initProject(cwd);
        console.log(touched.length ? 'project scaffold:\n  ' + touched.join('\n  ') : 'project already scaffolded');
      }
      if (!opts.projectOnly) {
        let config: any = {};
        try { config = JSON.parse(readFileSync(join(cwd, 'n8c.config.json'), 'utf8')); } catch {}
        const database = config.database ?? 'mongodb';
        const env = envOf() ?? config.defaultEnv ?? 'default';
        const vars = { ...loadEnv(cwd, env), ...process.env };
        if (database === 'mongodb' && !vars.MONGO_URI) { console.log('DB setup skipped (no MONGO_URI configured yet)'); return; }
        const { createStore } = await import('./store/factory.ts');
        const store = await createStore(database, vars as any, { collectionPrefix: config.collectionPrefix, collections: config.collections, sqlite: config.sqlite });
        try {
          const r = await initDb(store);
          console.log(`DB indexes reconciled: ${r.indexes.join(', ')}`);
          // Replica-set / transaction warning only applies to Mongo; a sqlite file
          // is always single-writer and transactional.
          if (database === 'mongodb') console.log(r.replicaSet ? 'replica set: OK (transactions supported)' : 'WARNING: not a replica set — apply transactions will fail');
          if (store.capabilities.promptContents === false) console.log('note: runtime prompt-content feature is disabled on this backend');
        } finally { await store.close(); }
      }
    });

  // (build runs automatically inside plan/apply — no public `build` command)

  // --- plan: diff desired files vs live n8n/Mongo → write a state file ---
  program.command('plan')
    .description('diff desired files vs live n8n + Mongo; write .states/n8c.state.<env>.json')
    .option('--destroy', 'include deletes for workflows on the server but absent from files')
    .action(async (opts) => {
      const { ctx, store, root } = await buildContext(process.cwd(), 'workflows', envOf());
      try {
        const { computePlan, writeState } = await import('./engine/state.ts');
        const state = await computePlan(store, root, ctx, { destroy: !!opts.destroy, version: pkgVersion() });
        printPlanSummary(state);
        console.log(`state written → ${writeState(process.cwd(), ctx.env, state)}`);
      } finally { await store.close(); }
    });

  // --- apply: execute the saved plan (push then commit, per resource) ---
  program.command('apply')
    .description('execute the saved plan from `n8c plan` (push to n8n, then commit the DB)')
    .option('--force', 'compute a fresh plan and apply it in one step (no saved plan needed, like `terraform apply`)')
    .option('--destroy', 'with --force: include workflow deletes (archive) for server-only workflows')
    .option('-m, --message <msg>', 'note recorded on the release (shown in `n8c list`)')
    .action(async (opts) => {
      const { ctx, store, root } = await buildContext(process.cwd(), 'workflows', envOf());
      try {
        const { computePlan, readState, desiredBundleChecksum, writeState } = await import('./engine/state.ts');
        const { applyFromState } = await import('./engine/apply-state.ts');
        let state;
        if (opts.force) {
          state = await computePlan(store, root, ctx, { destroy: !!opts.destroy, version: pkgVersion() });
          printPlanSummary(state);
        } else {
          state = readState(process.cwd(), ctx.env);
          if (await desiredBundleChecksum(root, ctx) !== state.desiredChecksum) throw new Error('files changed since plan; re-run `n8c plan` (or `n8c apply --force`)');
        }
        writeState(process.cwd(), ctx.env, state);
        const done = await applyFromState(store, root, ctx, state, { message: opts.message });
        writeState(process.cwd(), ctx.env, done);
        printApplied(done);
        if (done.applied!.failed.length) process.exitCode = 1;
      } finally { await store.close(); }
    });

  // --- list: the generation (release) timeline ---
  // A "version" IS a generation: apply/restore/drop always operate on the whole
  // instance, never a single resource — so there is no per-kind listing.
  program.command('list')
    .description('list generation versions (releases), newest first')
    .option('--full', 'show untruncated messages')
    .action(async (opts) => {
      const { ctx, store } = await buildContext(process.cwd(), 'workflows', envOf());
      try {
        for (const gen of groupByGeneration(await readGenerations(store, ctx))) console.log(renderGeneration(gen, !!opts.full));
      } finally { await store.close(); }
    });

  // --- pull: n8n + Mongo → DB, then write the pulled version to files ---
  program.command('pull')
    .description('pull all entities from the active env and write them to files (use --no-export to skip files)')
    .option('--no-export', 'pull into the DB only; do not write files')
    .option('-y, --yes', 'skip the overwrite confirmation (for non-interactive use)')
    .option('-m, --message <msg>')
    .action(async (opts) => {
      const { ctx, store, root } = await buildContext(process.cwd(), 'workflows', envOf());
      try {
        // pull rewrites files under the n8c root to mirror n8n's current state —
        // it OVERWRITES and PRUNES entity dirs, so any un-pulled local edits are
        // lost. Confirm first (unless --no-export, --yes, or the root is empty).
        if (opts.export !== false && !opts.yes && dirHasEntities(root)) {
          if (!process.stdin.isTTY) throw new Error('pull overwrites files under the n8c root (local edits are lost). Re-run with -y/--yes to confirm in a non-interactive shell.');
          const { createInterface } = await import('node:readline/promises');
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          let answer = '';
          console.log(danger("! This overwrites the n8c root with n8n's current state — un-pulled local edits will be lost."));
          try { answer = (await rl.question('Continue? [y/N] ')).trim().toLowerCase(); }
          finally { rl.close(); }
          if (answer !== 'y' && answer !== 'yes') { console.log('pull aborted — nothing changed.'); return; }
        }
        // Phase 1 — fetch every kind's current reality (no versions written yet).
        const groups = Object.entries(GROUP_TO_KIND).filter(([, k]) => !(k === 'promptContents' && ctx.promptContentsEnabled === false));
        const pulled: { g: string; kind: string; desc: any; result: any }[] = [];
        for (const [g, kind] of groups) {
          const desc = entityByKind[kind];
          let result;
          if (kind === 'prompts') {
            const { pullPromptsFromNodes } = await import('./engine/pull-prompts.ts');
            result = await pullPromptsFromNodes(store, ctx);
          } else {
            result = await pullEntity(store, desc, root, ctx);
          }
          pulled.push({ g, kind, desc, result });
        }

        // Map credentials from workflow NODES *after* every pull. The credential
        // pull writes the mapping with replace-semantics from `listCredentials`,
        // which only returns credentials this API key can see — a credential living
        // in another n8n project would be dropped. This pass merges on top, so
        // node-referenced credentials survive and workflow export can resolve them.
        {
          const { mapCredentialsFromWorkflows } = await import('./engine/environment.ts');
          const m = await mapCredentialsFromWorkflows(store, ctx);
          console.log('  ' + info(`↳ mapped ${m.mapped} credential(s) from workflows`));
        }

        // Phase 2 — commit ONE generation for the whole pull (like apply), but only
        // if something actually differs from the currently-active generation.
        const activeGen = groupByGeneration(await readGenerations(store, ctx)).find((x) => x.active);
        const changedKinds = pulled.filter((p) => activeGen?.members.find((m) => m.kind === p.kind)?.checksum !== p.result.checksum);
        for (const p of pulled) {
          const changed = changedKinds.includes(p);
          console.log(`pulled ${p.g} ${p.result.count} — ${hash(p.result.checksum.slice(0, 8))} — ${changed ? 'changed' : dim('no changes')}`);
        }
        if (changedKinds.length) {
          const { commitPullGeneration } = await import('./engine/pull.ts');
          const { nextVersionId } = await import('./version.ts');
          const generation = nextVersionId();
          await commitPullGeneration(store, generation, pulled.map((p) => p.result), opts.message);
          const gen = groupByGeneration(await readGenerations(store, ctx)).find((x) => x.versionId === generation);
          console.log(ok(`✓ generation ${gen ? gen.hash.slice(0, 8) : generation} created`) + ` ${dim(generation)}`);
        } else {
          console.log(notice('= nothing changed — no new generation'));
        }

        // Phase 3 — write the just-pulled docs to files (straight from what we
        // pulled — no re-read of a stored version). A per-kind failure is reported
        // but never aborts the whole pull (other kinds still export).
        if (opts.export !== false) {
          // regenerate types first — the exported files `import type` from it
          try { await writeTypesFile(store, ctx, root); console.log('  ' + info('↳ types regenerated')); }
          catch (e: any) { console.error('  ' + `⚠ types skipped: ${String(e?.message ?? e)}`); }
          for (const p of pulled) {
            if (!p.result.docs.length) continue;
            try {
              const warns = await exportDocs(p.desc, root, p.result.docs, ctx);
              console.log('  ' + info(`↳ exported ${p.g} to files`));
              printSecretWarnings(warns);
            } catch (e: any) {
              console.error('  ' + `⚠ export skipped for ${p.g}: ${String(e?.message ?? e)}`);
            }
          }
        }
      } finally { await store.close(); }
    });

  // --- types: generate n8c/n8c.types.ts (editor-only types) ---
  program.command('types')
    .description('generate n8c/n8c.types.ts — credential field types (from n8n) + entity shapes')
    .action(async () => {
      const { ctx, store, root } = await buildContext(process.cwd(), 'credentials', envOf());
      try { console.log(`types written → ${await writeTypesFile(store, ctx, root)}`); }
      finally { await store.close(); }
    });

  // --- db: dump / restore the whole n8c DB (records + indexes) ---
  const db = program.command('db').description('back up / restore the n8c DB collections');
  db.action(() => db.help());
  db.command('export')
    .description('dump all n8c collections (records + indexes) to a backup file')
    .option('-o, --out <file>', 'output file', 'db.n8c-backup')
    .action(async (opts) => {
      const { store } = await buildContext(process.cwd(), 'workflows', envOf());
      try {
        const { dumpBackup } = await import('./engine/backup.ts');
        const file = await dumpBackup(store.backupDb(), pkgVersion());
        writeFileSync(opts.out, JSON.stringify(file, null, 2) + '\n');
        const docs = Object.values(file.collections).reduce((a, c) => a + c.docs.length, 0);
        console.log(`backed up ${Object.keys(file.collections).length} collections, ${docs} record(s) → ${opts.out}`);
      } finally { await store.close(); }
    });
  db.command('import [file]')
    .description('recreate collections + import records from a backup file (drops existing n8c collections)')
    .action(async (fileArg?: string) => {
      const { store } = await buildContext(process.cwd(), 'workflows', envOf());
      try {
        const { restoreBackup } = await import('./engine/backup.ts');
        const data = JSON.parse(readFileSync(fileArg ?? 'db.n8c-backup', 'utf8'));
        const r = await restoreBackup(store.backupDb(), data);
        console.log(`restored ${r.collections} collections, ${r.docs} record(s), ${r.indexes} index(es)`);
      } finally { await store.close(); }
    });

  // --- create ---
  program.command('create <type>')
    .description('scaffold a workflow|prompt|credential|node')
    .option('--name <name>')
    .option('--description <text>')
    .option('--type <nodeType>', 'node/credential type')
    .option('--key <key>', 'prompt key')
    .option('--workflow <workflowId>', 'target workflow (required for node)')
    .action(async (type: string, opts) => {
      if (!['workflow', 'prompt', 'credential', 'node'].includes(type)) throw new Error(`unknown create type ${type}`);
      const root = resolveRoot(process.cwd());
      const o: any = { name: opts.name, description: opts.description, nodeType: opts.type, key: opts.key, workflowId: opts.workflow };
      if (process.stdin.isTTY && type === 'node' && !o.workflowId) {
        const { createInterface } = await import('node:readline/promises');
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        try { o.workflowId = (await rl.question('workflowId: ')).trim(); } finally { rl.close(); }
      }
      const g = createEntity(root, type as any, o);
      console.log(`created ${type} ${g.localId}`);
    });

  // --- restore: roll the whole instance back to a generation version ---
  program.command('restore <generation>')
    .description('roll every kind back to a generation version (rollback); then `plan`/`apply`, or --apply now')
    .option('--apply', 'materialize → plan → apply in one shot (incident rollback)')
    .action(async (ref: string, opts) => {
      const { ctx, store, root } = await buildContext(process.cwd(), 'workflows', envOf());
      try {
        // An apply writes ALL kinds under one shared generation, so resolving the
        // ref (short hash or full versionId) gives one versionId to restore across
        // every kind that generation covers.
        const perKind = await readGenerations(store, ctx);
        const vid = resolveGenerationRef(groupByGeneration(perKind), ref);
        for (const { kind, versions } of perKind) {
          if (!versions.some((v: any) => v.versionId === vid)) continue; // not part of this generation
          printSecretWarnings(await exportVersion(store, entityByKind[kind], root, vid, ctx));
          console.log(`restored ${KIND_TO_SINGULAR[kind] ?? kind} → files.`);
        }
        console.log(`generation ${hash(ref)} (${vid}) restored.`);
        if (!opts.apply) { console.log('Run `n8c plan` to preview, `n8c apply` to deploy.'); return; }
        const { computePlan, writeState } = await import('./engine/state.ts');
        const { applyFromState } = await import('./engine/apply-state.ts');
        const state = await computePlan(store, root, ctx, { destroy: false, version: pkgVersion() });
        printPlanSummary(state);
        writeState(process.cwd(), ctx.env, state);
        const done = await applyFromState(store, root, ctx, state, { message: `restore ${ref}` });
        writeState(process.cwd(), ctx.env, done);
        printApplied(done);
      } finally { await store.close(); }
    });

  // --- drop: delete one or more versions from history ---
  program.command('drop <generations...>')
    .description('delete generation versions from history (each drops across every kind); live docs untouched')
    .action(async (refs: string[]) => {
      const { ctx, store } = await buildContext(process.cwd(), 'workflows', envOf());
      try {
        // Resolve each ref (short hash or full versionId) to a generation, then
        // delete it across every kind it covers.
        const perKind = await readGenerations(store, ctx);
        const gens = groupByGeneration(perKind);
        const targets = refs.map((ref) => {
          const vid = resolveGenerationRef(gens, ref);
          return gens.find((g) => g.versionId === vid)!;
        });
        // Hard guard: the active generation is the deploy/rollback baseline and can
        // NEVER be dropped. Switch the baseline first (`n8c restore <other>` or a
        // fresh `n8c apply`), then drop the old one.
        const active = targets.filter((g) => g.active);
        if (active.length) {
          throw new Error(`cannot drop the active generation: ${active.map((g) => g.hash.slice(0, 8)).join(', ')}\n` +
            `the active generation is the deploy/rollback baseline — make another one active first (\`n8c restore <other>\` or a new \`n8c apply\`), then drop this one.`);
        }
        for (const g of targets) {
          for (const kind of g.kinds) await store.withTransaction((s) => store.dropVersion(kind, g.versionId, s));
          console.log(`dropped generation ${hash(g.hash.slice(0, 8))} (${g.versionId})`);
        }
        console.log(dim(`${targets.length} generation(s) dropped`));
      } finally { await store.close(); }
    });

  // An unknown command → error + help, non-zero exit. (No-args help is handled
  // at the entry point so it doesn't clash with this handler.)
  program.showHelpAfterError();
  program.on('command:*', (operands: string[]) => {
    console.error(`error: unknown command '${operands[0]}'\n`);
    program.outputHelp();
    process.exitCode = 1;
  });

  return program;
}

function isEntryPoint(): boolean {
  const arg = process.argv[1];
  if (!arg) return false;
  try { return pathToFileURL(realpathSync(arg)).href === pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href; }
  catch { return false; }
}

if (isEntryPoint()) {
  const program = buildProgram();
  // --pipe / --debug are global and position-independent: strip them before parsing
  // so they're accepted after any subcommand (the preAction hook reads process.argv).
  const argv = process.argv.filter((a) => a !== '--pipe' && a !== '--debug');
  if (argv.slice(2).length === 0) { program.outputHelp(); process.exit(0); } // no command → help
  program.parseAsync(argv).catch((e) => { console.error(e.message); process.exit(1); });
}

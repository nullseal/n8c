#!/usr/bin/env node
import { Command } from 'commander';
import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { buildContext } from './context.ts';
import { entityByKind } from './entities/index.ts';
import { listEntity } from './engine/list.ts';
import { pullEntity } from './engine/pull.ts';
import { exportVersion, exportDocs } from './engine/transfer.ts';
import { createEntity } from './engine/generate.ts';
import { initProject, initDb } from './engine/init.ts';
import { loadEnv } from './env.ts';
import { hash, status as styleStatus, active, dim, info, setStyle } from './style.ts';

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
function printPlanSummary(state: { summary: any; resources: any[] }): void {
  for (const r of state.resources) {
    if (r.action === 'noop') continue;
    const type = KIND_TO_SINGULAR[r.kind] ?? r.kind;
    const nodes = r.nodes?.length ? '  (' + r.nodes.map((n: any) => n.name).join(', ') + ')' : '';
    console.log(`  ${styleStatus(ACTION_STATUS[r.action])} ${ACTION_SIGN[r.action]} ${type}  ${r.name}${nodes}`);
  }
  const s = state.summary;
  console.log(`Plan: ${s.create} to create, ${s.update} to update, ${s.delete} to destroy.`);
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

// One pull result line: `pulled <kind> <n> — <hash> — <no changes | versionId>`.
function pulledLine(g: string, r: { count: number; checksum: string; deduped: boolean; versionId?: string }): string {
  const tail = r.deduped ? dim('no changes') : (r.versionId ?? '');
  return `pulled ${g} ${r.count} — ${hash(r.checksum.slice(0, 8))} — ${tail}`;
}

// Loudly warn about hardcoded secrets found in exported workflow files — n8c/
// is committed, so an inline token would land in git.
function printSecretWarnings(warnings: string[]): void {
  if (!warnings.length) return;
  console.error(`  ⚠ possible hardcoded secret(s) in exported files (n8c/ is committed — scrub & rotate):`);
  for (const w of warnings) console.error(`    - ${w}`);
}

// Resolve a version reference against a manifest: an exact versionId, or a
// unique checksum (hash) prefix — git-style, so a short hash aliases the id.
export function resolveVersionRef(versions: { versionId: string; checksum: string }[], ref: string): string {
  if (versions.some((v) => v.versionId === ref)) return ref;
  const hits = versions.filter((v) => v.checksum.startsWith(ref));
  if (hits.length === 1) return hits[0].versionId;
  if (hits.length > 1) throw new Error(`ambiguous version hash "${ref}" (${hits.length} matches)`);
  throw new Error(`no version matching "${ref}"`);
}

// Pick a version: an explicit ref (id or hash prefix), else the active version,
// else the newest. Throws when there are no versions.
export function pickVersion(versions: { versionId: string; checksum: string; isActive: boolean }[], ref?: string): string {
  if (ref) return resolveVersionRef(versions, ref);
  const active = versions.find((v) => v.isActive);
  if (active) return active.versionId;
  if (versions.length) return versions[versions.length - 1].versionId; // sorted ascending → newest
  throw new Error('no versions available');
}

// Render one manifest version line: `<active> <hash> <versionId> [draft] <msg>`.
// Hash sits left of the versionId date string (consistent with apply/pull). The
// version `message` is truncated unless `full` (which also shows the full hash).
export function renderVersion(v: { isActive: boolean; versionId: string; checksum: string; draft?: boolean; message?: string }, full: boolean): string {
  const h = full ? v.checksum : v.checksum.slice(0, 8);
  let msg = v.message ?? '';
  if (!full && msg.length > MSG_MAX) msg = msg.slice(0, MSG_MAX - 1) + '…';
  return `${v.isActive ? active('*') : ' '} ${hash(h)} ${v.versionId}${v.draft ? ' [draft]' : ''}${msg ? ' ' + msg : ''}`;
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
    .option('--pipe', 'raw output — no color/style (for piping/parsing)');

  const envOf = () => program.opts().env as string | undefined;

  // Enable color per run unless --pipe (anywhere on the line), a non-TTY
  // stdout, or NO_COLOR. Scanning argv keeps --pipe position-independent.
  program.hook('preAction', () => {
    setStyle(!!process.stdout.isTTY && !process.argv.includes('--pipe') && !process.env.NO_COLOR);
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
        const done = await applyFromState(store, root, ctx, state);
        writeState(process.cwd(), ctx.env, done);
        printApplied(done);
        if (done.applied!.failed.length) process.exitCode = 1;
      } finally { await store.close(); }
    });

  // --- global list (all entities) ---
  program.command('list')
    .description('list versions for all entities')
    .option('--full', 'show the full checksum and untruncated message')
    .action(async (opts) => {
      const { ctx, store } = await buildContext(process.cwd(), 'workflows', envOf());
      try {
        for (const [g, kind] of Object.entries(GROUP_TO_KIND)) {
          if (kind === 'promptContents' && ctx.promptContentsEnabled === false) continue;
          console.log(`# ${g}`);
          // Display newest-first (store keeps versions ascending for apply/pull dedup).
          for (const v of (await listEntity(store, entityByKind[kind])).slice().reverse()) console.log(renderVersion(v, !!opts.full));
        }
      } finally { await store.close(); }
    });

  // --- pull: n8n + Mongo → DB, then write the pulled version to files ---
  program.command('pull')
    .description('pull all entities from the active env and write them to files (use --no-export to skip files)')
    .option('--no-export', 'pull into the DB only; do not write files')
    .option('-m, --message <msg>')
    .action(async (opts) => {
      const { ctx, store, root } = await buildContext(process.cwd(), 'workflows', envOf());
      try {
        for (const [g, kind] of Object.entries(GROUP_TO_KIND)) {
          if (kind === 'promptContents' && ctx.promptContentsEnabled === false) continue;
          const desc = entityByKind[kind];
          let docs;
          if (kind === 'prompts') {
            const { pullPromptsFromNodes } = await import('./engine/pull-prompts.ts');
            const r = await pullPromptsFromNodes(store, ctx, { message: opts.message });
            console.log(pulledLine(g, r)); docs = r.docs;
          } else {
            const r = await pullEntity(store, desc, root, ctx, { message: opts.message });
            console.log(pulledLine(g, r)); docs = r.docs;
            if (kind === 'workflows') {
              const { mapCredentialsFromWorkflows } = await import('./engine/environment.ts');
              const m = await mapCredentialsFromWorkflows(store, ctx);
              console.log('  ' + info(`↳ mapped ${m.mapped} credential(s) from workflows`));
            }
          }
          // Write the just-pulled docs to files (straight from what we pulled — no
          // re-read of a stored version). A per-kind failure is reported but never
          // aborts the whole pull (other kinds still export).
          if (opts.export !== false && docs && docs.length) {
            try {
              const warns = await exportDocs(desc, root, docs, ctx);
              console.log('  ' + info(`↳ exported to files`));
              printSecretWarnings(warns);
            } catch (e: any) {
              console.error('  ' + `⚠ export skipped for ${g}: ${String(e?.message ?? e)}`);
            }
          }
        }
      } finally { await store.close(); }
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

  // --- restore: roll back by rewriting files from a snapshot version ---
  program.command('restore <ref>')
    .description('rewrite files from a snapshot version (rollback); then `plan`/`apply`, or --apply now')
    .option('--apply', 'materialize → plan → apply in one shot (incident rollback)')
    .action(async (ref: string, opts) => {
      const { ctx, store, root } = await buildContext(process.cwd(), 'workflows', envOf());
      try {
        // An apply writes ALL kinds under one shared generation versionId, so a
        // generation ref matches every kind → restore them all (coherent rollback).
        // A single-kind ref (a checksum prefix, or a kind-specific pull version)
        // matches just that kind.
        const kinds = ['workflows', 'prompts', 'credentials', ...(ctx.promptContentsEnabled === false ? [] : ['promptContents'])];
        const matches: { kind: string; vid: string }[] = [];
        for (const kind of kinds) {
          try { matches.push({ kind, vid: resolveVersionRef(await listEntity(store, entityByKind[kind]), ref) }); } catch { /* no match in this kind */ }
        }
        if (!matches.length) throw new Error(`no version matching "${ref}"`);
        for (const { kind, vid } of matches) {
          printSecretWarnings(await exportVersion(store, entityByKind[kind], root, vid, ctx));
          console.log(`restored ${KIND_TO_SINGULAR[kind] ?? kind} ${vid} → files.`);
        }
        if (!opts.apply) { console.log('Run `n8c plan` to preview, `n8c apply` to deploy.'); return; }
        const { computePlan, writeState } = await import('./engine/state.ts');
        const { applyFromState } = await import('./engine/apply-state.ts');
        const state = await computePlan(store, root, ctx, { destroy: false, version: pkgVersion() });
        printPlanSummary(state);
        writeState(process.cwd(), ctx.env, state);
        const done = await applyFromState(store, root, ctx, state);
        writeState(process.cwd(), ctx.env, done);
        printApplied(done);
      } finally { await store.close(); }
    });

  // --- drop: delete one or more versions from history ---
  program.command('drop <refs...>')
    .description('delete versions from history (a generation id drops from every kind); live docs untouched')
    .action(async (refs: string[]) => {
      const { ctx, store } = await buildContext(process.cwd(), 'workflows', envOf());
      try {
        const kinds = ['workflows', 'prompts', 'credentials', ...(ctx.promptContentsEnabled === false ? [] : ['promptContents'])];
        // Resolve each ref across kinds → the set of (kind, versionId) to drop. A
        // generation id matches every kind; a checksum prefix / pull version matches one.
        const targets: { kind: string; vid: string; active: boolean }[] = [];
        for (const ref of refs) {
          const found: typeof targets = [];
          for (const kind of kinds) {
            const versions = await listEntity(store, entityByKind[kind]);
            try {
              const vid = resolveVersionRef(versions, ref);
              found.push({ kind, vid, active: !!versions.find((v) => v.versionId === vid)?.isActive });
            } catch { /* not in this kind */ }
          }
          if (!found.length) throw new Error(`no version matching "${ref}"`);
          targets.push(...found);
        }
        // Hard guard: the active version is the deploy/rollback baseline and can
        // NEVER be dropped. Switch the baseline first (`n8c restore <other>` or a
        // fresh `n8c apply`), then drop the old one.
        const active = targets.filter((t) => t.active);
        if (active.length) {
          throw new Error(`cannot drop the active version: ${active.map((t) => `${KIND_TO_SINGULAR[t.kind] ?? t.kind} ${t.vid}`).join(', ')}\n` +
            `the active version is the deploy/rollback baseline — make another version active first (\`n8c restore <other>\` or a new \`n8c apply\`), then drop this one.`);
        }
        for (const t of targets) {
          await store.withTransaction((s) => store.dropVersion(t.kind, t.vid, s));
          console.log(`dropped ${KIND_TO_SINGULAR[t.kind] ?? t.kind} ${hash(t.vid)}`);
        }
        console.log(dim(`${targets.length} version(s) dropped`));
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
  // --pipe is global and position-independent: strip it before parsing so it's
  // accepted after any subcommand (the preAction hook reads it from process.argv).
  const argv = process.argv.filter((a) => a !== '--pipe');
  if (argv.slice(2).length === 0) { program.outputHelp(); process.exit(0); } // no command → help
  program.parseAsync(argv).catch((e) => { console.error(e.message); process.exit(1); });
}

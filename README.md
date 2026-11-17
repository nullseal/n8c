# n8c

**Version control and a safety net for your n8n — built for the age of AI-edited workflows.**

🔗 **[Website & docs](https://nullseal.github.io/n8c)** · 📦 **[npm](https://www.npmjs.com/package/n8c)** · 🐙 **[GitHub](https://github.com/nullseal/n8c)** · ⚖️ [MIT](LICENSE)

---

AI agents can build and change n8n workflows at incredible speed. They can also silently overwrite a
node, drop a prompt, or break a flow you can't easily reconstruct — and while n8n keeps per-workflow
revisions, there's no diff, no cross-workflow view, and no coherent way to roll a whole instance back
through a pile of history. **n8c is the safety net.** It keeps your n8n **workflows, prompts and
credentials** as code with full version history in a database, deploys them with a Terraform-style
`plan` / `apply` loop, and lets you roll the *entire* instance back to a known-good release in a
single command.

```bash
n8c pull        # snapshot your live n8n → versioned files + DB history
# let an AI (or a teammate) edit the files…
n8c plan        # see exactly what will change vs live — no surprises
n8c apply       # deploy; every apply is a restorable release
n8c restore <release>   # something broke? roll the whole instance back in one command
```

Dependency-light and zero setup: history goes into a single **SQLite** file by default (Node's
built-in `node:sqlite` — no service to run), so the only runtime dependency you need is
[`commander`](https://www.npmjs.com/package/commander). Switch to
[`mongodb`](https://www.npmjs.com/package/mongodb) when you want a shared/team store.

---

## Why n8c

**A safety net for AI-driven automation.** When you let an AI agent loose on your n8n instance, one
bad edit can quietly cost you hours — and hunting through per-workflow history to piece the old state
back together is its own headache. n8c snapshots *every* change and ties each `apply` into a single
coherent **release**, so `n8c restore <release>` returns your whole instance — workflows, prompts and
credentials together — to a point you know was good.

**Secrets your AI never sees.** Credential values live only in your `.env` and are resolved from
`process.env` at deploy time — never written to a file, never committed to git, never sitting in the
directory an AI agent is working in. All that lives in code is a reference like
`process.env.MY_TOKEN`. The agent can edit your automation without ever touching a real key.

**Encrypted at rest.** Before a credential is stored in the database it's encrypted with AES-256-GCM
(`N8C_CREDENTIAL_ENCRYPTION_KEY`) — never persisted in plaintext.

**Build on staging, ship to prod — the same files.** Entities are identified by env-neutral IDs, and
n8c **auto-maps** each environment's real n8n and credential IDs for you. Develop and test against
staging, then run `n8c -e prod apply` on the *exact same files* — credentials are matched per
environment automatically, so you never hand-edit IDs to promote a change.

**A real plan/apply loop.** `plan` diffs your files against the *live* n8n server and freezes the
actions into a state file; `apply` executes exactly that plan, pushing to n8n *before* recording
success — so a failed deploy never leaves the database claiming it worked. And it's dependency-light:
only [`commander`](https://www.npmjs.com/package/commander) on top of built-in SQLite (or
[`mongodb`](https://www.npmjs.com/package/mongodb) if you opt into that backend).

## Requirements

- **Node.js ≥ 22.18** (or ≥ 23.6) — n8c ships TypeScript sources and relies on Node's built-in type
  stripping, which is enabled by default from these versions. See
  [Cross-platform & Node versions](#cross-platform--node-versions).
- **A database** — **SQLite by default**: a single local file, nothing to install or run, via Node's
  built-in `node:sqlite`. Switch to **MongoDB** for a shared/team store or the runtime prompt-content
  feature (a replica set is recommended there so `apply` can snapshot atomically). See
  [Storage backends](#storage-backends).
- **n8n** with the **Public API** enabled on **n8n 2.x or 3.x** (Public API v1) and an API key. Some features need a later 2.x release; see [n8n versions](#n8n-versions).

## Install

```bash
npm install -g n8c
# or, without a global install:
npx n8c --help
```

## Quickstart

```bash
# 1. Scaffold config, .env and .gitignore, and set up the DB.
#    Defaults to SQLite, so this creates ./n8c.sqlite — no service to start.
n8c init

# 2. Fill in .env:  N8N_BASE, N8N_API_KEY,
#    and (if you encrypt credentials) N8C_CREDENTIAL_ENCRYPTION_KEY.

# 3. Import everything from your n8n instance into the DB and onto disk.
n8c pull

# 4. Edit the generated files under n8c/ and commit them to git.

# 5. Preview and deploy.
n8c plan
n8c apply
```

## Concepts

### Entities

Each managed thing lives as a folder of code under the `n8c/` root:

```
n8c/
├── workflows/<localId>/
│   ├── metadata.json        # name, description, …
│   └── apply.ts             # returns the workflow body (nodes/connections/settings)
├── prompts/<localId>/{ metadata.json, apply.ts }
├── prompt-contents/<localId>/{ metadata.json, apply.ts }
└── credentials/<localId>/{ metadata.json, apply.ts }
```

`apply.ts` default-exports the entity body (a value, or a function returning one). Workflows export
as readable code — each node a named object, Code-node `jsCode` as a template literal, connections
inline.

`localId`s are env-neutral UUIDs, minted by `create` or `pull` — never the n8n ID. The real per-env
n8n ID is resolved from the DB mapping at push time, so the same files deploy anywhere.

### Typed authoring

`n8c types` (also run automatically by `pull`) generates **`n8c/n8c.types.ts`** so your editor knows
each entity's shape — and, crucially, each credential's **real `data` field names**, fetched from your
instance via n8n's `GET /credentials/schema/{type}`. Since n8n never returns credential data, this is
the only way to know them; without it a wrong key is only discovered as a 400 at apply time.

```ts
import type { Credential } from '../../n8c.types.ts';

export default (): Credential<'httpHeaderAuth'> => ({
  name: 'Shopify Admin',
  type: 'httpHeaderAuth',
  data: { name: 'Authorization', value: process.env.MY_TOKEN }, // wrong key → editor error
});
```

`import type` and return-type annotations are **erasable**, so Node's type stripping runs these files
unchanged — the types exist purely for your editor. Credential types with alternative field sets come
through as unions (e.g. `mongoDb` → `{ connectionString }` or `{ host, port }`), and a schema n8n
won't serve degrades to `Record<string, unknown>` rather than failing.

It also writes a `tsconfig.json` (if you don't have one) so the `.ts` import specifiers resolve, and —
only when your project has no `@types/node` — a minimal ambient `process.env` so `process.env.MY_TOKEN`
type-checks. That shim is conditional on purpose: declaring it alongside `@types/node` fails with
`TS2403`.

### Two prompt kinds

- **`prompts`** — build-time prompts wired into agent / LLM nodes at deploy.
- **`prompt-contents`** — a **runtime** prompt store your workflow reads from the DB at execution
  time. It's a normal managed entity but **DB-only**: `plan` / `apply` never push it to n8n. Its live
  docs are stored flat (`{ key, content | blocks, mode: "live" }`) so a node can read
  `x.json.key` / `x.json.content` directly.

### Database collections

All collections default to `n8c_<name>` and are fully renameable:

| Collection             | Holds |
|------------------------|-------|
| `n8c_workflows`        | live workflow docs + every version, tagged by `versionId` |
| `n8c_prompts`          | live prompt docs + versions |
| `n8c_prompt_contents`  | live runtime-prompt docs + versions |
| `n8c_credentials`      | live credential docs (encrypted) + versions |
| `n8c_manifests`        | **only** version metadata — one doc per `{ kind, versionId }` |
| `n8c_definitions`      | per-env `localId → n8nId` mapping, one doc per entity |

Override the prefix or any single name in `n8c.config.json`:

```jsonc
{
  "collectionPrefix": "myapp_",                          // rename all at once
  "collections": { "promptContents": "runtime_prompts" } // …or one at a time
}
```

### Plan / apply

`plan` computes actions against the **live** state (workflows and credentials diffed against the n8n server, prompts against the DB), freezes them into `.states/n8c.state.<env>.json` — including which credential each workflow node is bound to. If the credential listing fails (an expired API key, or a key without permission), `plan` says so explicitly and falls back to comparing against the local database only.

`apply` executes the frozen plan — pushing to n8n *before* committing the DB. `apply` refuses a stale plan (files changed since `plan`). Use `n8c apply --force` to compute a fresh plan and apply it in one step, Terraform-style.

- **Workflow `active` state is managed** — pulled, diffed, and reached via n8n's
  `activate` / `deactivate` endpoints with `"n8nVersion": "2"`, or `publish` / `unpublish` with `"3"`
  (see [n8n versions](#n8n-versions)).
- **Credentials reconcile in place** via `PATCH`, using the server's `updatedAt` as a change token —
  no duplicates; missing-on-server is recreated.
- **`plan --destroy`** marks workflows that exist on the server but not in your files; `apply`
  **archives** them (soft, recoverable) rather than hard-deleting.

A workflow is `changed` when any of these differ from the server: a node, the
`active` flag, the workflow `name`, `connections`, `description`, `nodeGroups`, or a
`settings` key your files actually set. `plan` names the parts that differ in
parentheses, e.g. `~ workflow  [id]  MKD_ Orders  (name, load_prompts)`.

Two things are deliberately never a reason to plan an update, though both are still
pushed: `staticData` (n8n's runtime scratch space, which it rewrites between
executions) and `settings` keys your files leave unset (n8n fills in its own
defaults, and diffing those would leave every workflow permanently "changed").

### Renaming a workflow

Rename it in **both** files of the workflow's folder — `metadata.json` (which n8c
displays) and the `name` in `apply.ts` (which is what n8n is sent) — then
`plan` + `apply`. Workflows in the exploded layout (with a `nodes/` directory) build
their body from `metadata.json`, so there is only one place to edit.

`plan` refuses to run while the two disagree, naming both values, rather than
printing the new name and deploying the old one.

### Archived workflows

`plan` never updates a workflow that is archived on n8n — the API rejects it. If an
archived workflow still has a local file whose content differs, `plan` skips it and
prints a line naming it; unarchive it in n8n to let the change apply. An archived
workflow whose local file you deleted is still removable: `plan --destroy` plans a
hard delete for it (a live workflow is archived instead, which is recoverable).

Removing a file-less workflow therefore takes two rounds, by design: the first
`--destroy` archives it, and because n8n keeps listing archived workflows, `plan`
still reports it — labelled `(already archived on n8n)` so you can tell it apart
from a destroy that did nothing. A second `--destroy` deletes it for good. This
works whether or not n8c ever deployed the workflow: a workflow created in the
n8n UI has no entry in n8c's mapping, so the delete targets the n8n id `plan`
recorded.

### Stale-plan protection

`apply` verifies twice before it writes anything:

1. **Files** — the plan is rejected if any entity file changed since `plan` ran.
2. **Instance** — n8n is re-read, and `apply` stops if a workflow or credential
   *this plan writes* was modified or deleted on n8n in the meantime.

Only entities in the plan are checked, so unrelated activity on a shared instance
never blocks you. Use `--no-verify` to skip step 2; `--force` (plan + apply in one
step) is always fresh and skips it automatically.

Drift detection is a best-effort safety net: it relies on n8n's `updatedAt` timestamp
changing when an entity is edited. If a change does not bump that timestamp, it will
go undetected — strictly better than no checking, but not a guarantee of safety.

If n8n cannot be reached, `apply` stops rather than applying unverified.

#### Resolving drift

When `apply` blocks because n8n changed since your plan, pick a side:

- **Keep your files** (overwrite what changed on n8n): re-run `n8c plan`, review
  the diff — it now shows the n8n-side edits being overwritten — then `n8c apply`.
- **Keep n8n's version** (take the server's edits): `n8c pull` to import them into
  your files, then re-apply your own change on top and `n8c plan` again.

There is no force-my-side shortcut on purpose: the second `plan` is where you see
what you'd be destroying. (`--no-verify` exists but skips that safety, not the work.)

### Agents & MCP

Two commands make a repo agent-native:

`n8c init --agents` writes (or refreshes) a marker-delimited section in `AGENTS.md` telling
any AI agent how to work this repo: the pull → edit → plan → apply loop, the entity
layout, and the rules (no literal secrets, don't touch ids, re-plan on drift). Your
own content outside the `<!-- n8c:start -->` / `<!-- n8c:end -->` markers is never
touched — and if the marker pair itself is malformed (torn, doubled, or out of
order), `n8c init --agents` refuses with a clear error rather than guessing where your
content ends.

`n8c mcp` starts an MCP (stdio) server exposing the loop as tools — `n8c_pull`,
`n8c_plan`, `n8c_apply`, `n8c_list`, `n8c_restore` — for Claude Code, Cursor, or any
MCP client. Register it as a stdio server with command `n8c` and args `["mcp"]`.
Each tool call spawns the real CLI (with `--pipe`), so the drift gate and archived-
workflow rules apply exactly as they do in a terminal, and calls are handled
strictly in order. `drop` and the gate-bypass flags (`--force`, `--no-verify`) are
deliberately not exposed — an agent that hits the drift gate should re-plan, not
override it. One deletion path IS exposed, by design: `n8c_plan` accepts
`destroy: true` (same as `--destroy` in a terminal), so a plan+apply over MCP can
still delete server-only entities whose files were removed.

### Pull & versioning

`pull` captures the current reality and leaves you with a clean baseline — running `plan` right
after a `pull` should report **no changes**. Because it **overwrites and prunes** files under the
`n8c/` root to mirror n8n, it asks for a **`[y/N]` confirmation first** (skipped when there's nothing
to overwrite); pass **`-y` / `--yes`** to bypass it in CI or scripts, or `--no-export` to pull into
the DB only. When it does write:

- **One pull = one generation**, exactly like an apply: every kind is snapshotted under the *same*
  generation id and marked active, so the timelines never fragment. If nothing differs from the
  active generation, no new one is created (an unchanged re-pull adds nothing).
- It writes files that **mirror the pulled set exactly**: an entity directory whose id is no longer
  in the pulled set is removed, so orphaned dirs from earlier pulls never linger as phantom
  "create" entries in `plan`.
- For node-extracted **prompts** (DB-only, `plan` diffs them against the DB), the pulled set is also
  adopted as the live baseline — otherwise `plan` right after `pull` would show every extracted
  prompt as new. This only writes `n8c_prompts`, never the runtime `prompt-content` registry.

Version reads are **backward compatible**: a version written under an older on-disk/DB layout is
still readable, so a change to how versions are stored never orphans existing history. `n8c list`
shows newest-first.

### Releases & rollback

**One `apply` = one release.** When an `apply` changes anything, *every* kind is snapshotted under a
single shared **generation** version id — even kinds that didn't change. So the version timelines
stay aligned across workflows, prompts, credentials and prompt-content: a given generation id names
the exact state of *all* of them at that deploy.

**A "version" *is* a generation.** You never apply or roll back a single resource, so n8c has no
per-kind version view. `n8c list` shows each generation as its **hash + message**, followed by an
indented row of what that release contains — every kind with its own checksum. Newest first, `*`
marks the active one:

```
* 17257ffa: update abc
    credential b5051dc0 · prompt-content e1910a56 · prompt 0fde0b6a · workflow 17257ffa
  bfb2bb9d: initial release
    credential 91a2c3d4 · prompt-content 7c1e5f20 · prompt 3ab90d11 · workflow 5e33a1c8
```

The leading **generation hash** is what you pass around — git-style, any unique prefix works:
`n8c restore 17257ffa`, `n8c drop bfb2bb9d` (the full `versionId` is accepted too, and a trailing
`:` copied from the list is ignored). It's derived from the release's contents *and* its id, so it's
unique per release — two generations can legitimately hold identical content (a pull, then an apply
that changed nothing) and must still be separately addressable. Add **`--full`** to show the
untruncated hashes, the full message and the `versionId`.

That makes rollback coherent. `n8c restore <generation>` rewrites the files for **every** kind back
to that release in one shot (add `--apply` to redeploy immediately). An `apply` that changes nothing
creates no release (no empty generations).

To prune history, `n8c drop <generation...>` deletes one or more generations — each removes that
release across every kind at once. Live docs are untouched. The **active** generation can never be
dropped (it's the deploy / rollback baseline) — make another one active first with `restore` or a new
`apply`, then drop the old one.

### Secrets

Credential `apply.ts` reads secret values from the environment:

```ts
export default function () {
  return { name: 'My API', type: 'httpHeaderAuth', data: { token: process.env.MY_TOKEN } };
}
```

The reference (`process.env.MY_TOKEN`) is what lives in files and the DB — never the resolved secret.
At rest in the DB, credential data is encrypted with `N8C_CREDENTIAL_ENCRYPTION_KEY` (AES-256-GCM).
Because no secret is ever written to a file, the whole `n8c/` root is safe to commit.

**Credential `data` is write-only.** n8n marks it `writeOnly` and never returns it — not even
non-secret fields — so it can't be pulled, and n8n validates the *whole* schema even on a partial
update. n8c handles that for you:

- A `data` n8n rejects for a missing field is **retried without `data`**, so the rest of the
  credential still applies and the stored secret is left untouched (rather than failing the apply).
- **`allowedDomains` defaults to `"*"`** (any domain) when n8n asks for it and your file omits it.
  Set it explicitly to narrow it — your value is never overwritten. The default is only applied to
  fields n8n actually reports as missing, so it's never injected into a type that has no such field.

Use `--debug` to see the exact payload (with secrets redacted) if a credential is rejected.

### n8n projects

By default n8c uses the API key's default (personal) project. If your workflows live in a **team
project**, set `n8nProjectId` in `n8c.config.json` — n8c then scopes `pull` / `plan` to that project
and creates new credentials directly in it (on n8n 2.18 or later; before that n8n puts a new credential in the
API key's personal project). New workflows end up there too: with `"n8nVersion": "3"` the
create call names the project; with `"2"` n8c creates the workflow, then transfers it to the project.

## n8n versions

`n8nVersion` in `n8c.config.json` picks which n8n API n8c speaks: `"2"` or `"3"` (the number `2` / `3` also
works). It defaults to `"3"` when absent, and `n8c init` writes it explicitly. Any other value, `"1"`
included, makes these commands stop with `unsupported n8nVersion "<v>" — n8c supports n8n 2 and 3`:
`plan`, `apply`, `pull`, `list`, `types`, `db export`, `db import`, `restore` and `drop`. `init` and
`create` never check it, and neither does `mcp` at startup (each MCP tool call runs one of those
commands, so the call does).

| `n8nVersion` | Use with | Activate / deactivate | New workflow when `n8nProjectId` is set |
|---|---|---|---|
| `"2"` | n8n 2.x (minimums per feature below) | `POST /workflows/{id}/activate`, `…/deactivate` | `POST /workflows`, then `PUT /workflows/{id}/transfer` to the project |
| `"3"` (default) | n8n 3.x, and n8n 2.33+ | `POST /workflows/{id}/publish`, `…/unpublish` | `POST /workflows` with `projectId` in the body, no transfer |

**n8n 1.x is no longer supported.** **Upgrading:** a repo pointed at an n8n 2.x server must set
`"n8nVersion": "2"`. A config without `n8nVersion` is read as `"3"`, which uses endpoints that n8n 2.x
before 2.33 does not have.

`"2"` works with n8n 2.x. Workflows themselves (create, update, list, activate, transfer) work on every 2.x
release; some other features need a later one:

- credential updates (`PATCH /credentials/{id}`): n8n 2.4.0 or later;
- credential listing (`GET /credentials`, used by `pull`, `plan` and apply's drift check): n8n 2.8.0 or later;
- archiving a workflow (`POST /workflows/{id}/archive`, used by `plan --destroy` and `apply`): n8n 2.15.0 or later;
- creating a credential directly in `n8nProjectId`: n8n 2.18.0 or later (before that, new credentials land in
  the API key's personal project).

n8n 2.x and 3.x replaced "active" with **save vs publish**: saving a workflow stores a version, publishing
makes it the live one. n8c maps its `active` flag onto that: activating publishes, deactivating unpublishes
(through the endpoints in the table), and n8c reads a workflow as active when n8n reports an active version
(`activeVersionId`), not the deprecated `active` field.

**API key permissions.** Updating a published workflow makes n8n re-publish it. When n8n refuses that publish
with a 403 whose message names `workflow:activate` or `workflow:publish`, it **still keeps the new version as a
draft**, and n8c says so: grant the API key that permission and re-run `n8c apply` on the **same saved plan** (a
fresh `n8c plan` compares against n8n's saved draft and will show no change), or, to deploy without publishing,
unpublish the workflow in n8n first **and** set `active: false` in its file (the PUT would otherwise re-publish
it and hit the same 403 before any deactivate step), then run `n8c pull` to record the version n8n already saved
(a fresh `plan` is a no-op there, so n8c's database would never learn of it). Any other 403 (for example a key
without `workflow:update`, where n8n saved nothing) comes back as n8n's own error, unchanged.

## Storage backends

Set the backend with `database` in `n8c.config.json`. **`sqlite` is the default** — `n8c init`
writes `"database": "sqlite"` and everything works with no service running. Change that one field to
`"mongodb"` (and set `MONGO_URI` / `MONGO_DB`) when you outgrow a single file.

| Feature | **`sqlite`** (default) | **`mongodb`** |
|---|---|---|
| Setup | a single local file, zero setup | a running MongoDB server |
| Config | `sqlite.file` in config, or `SQLITE_PATH` in `.env` (default `n8c.sqlite`) | `MONGO_URI`, `MONGO_DB` in `.env` |
| Dependency | Node's built-in `node:sqlite` (nothing to install) | `mongodb` npm driver |
| Versioning, `plan` / `apply`, releases, `drop` | ✅ | ✅ |
| Multi-env credential mapping (`definitions`) | ✅ | ✅ |
| Concurrency | single-writer — one machine / one file | multi-writer — safe for a shared team/CI instance |
| Atomic `apply` snapshots | ✅ (single-file transactions, always) | ✅ (replica set recommended) |
| `db export` / `import` backup | — (the `.sqlite` file *is* the backup — just copy it) | ✅ |
| Runtime **prompt-content** feature | **disabled** (see below) | ✅ |
| Best for | solo dev, a quick trial, a single instance, CI | teams, shared staging/prod, the runtime prompt registry |

SQLite is the default because it makes the whole loop work out of the box — no services, just Node's
built-in `node:sqlite`, and the file *is* the backup. Switch to MongoDB for a shared/team setup; it's
also required if you use the runtime prompt-content registry.

**Why prompt-content is disabled on SQLite.** The `prompt-contents` collection exists so an n8n
`load_prompts` node can read runtime prompts from the database *while a workflow executes*. n8n can
only reach MongoDB for that, so on SQLite the whole feature is switched off: `plan`, `apply`, `pull`
and `list` simply skip the `prompt-contents` kind (n8c prints a note on `init`). Everything else —
workflows, build-time prompts, credentials, versioning, `plan`/`apply` — works identically.

```jsonc
// n8c.config.json — SQLite backend (the default, written by `n8c init`)
{ "database": "sqlite", "sqlite": { "file": "n8c.sqlite" } }

// n8c.config.json — switch to MongoDB (then set MONGO_URI / MONGO_DB in .env)
{ "database": "mongodb" }
```

## Commands

```
n8c init [--project-only | --db-only] [--agents]   Scaffold config/.env/.gitignore + reconcile DB indexes; --agents also writes AGENTS.md
n8c pull [--no-export] [-y]             n8n + DB → files (asks before overwriting; -y/--yes skips)
n8c plan [--destroy]                    Diff files vs live → write .states/n8c.state.<env>.json
n8c apply [--force] [--destroy] [--no-verify] [-m]    Execute the saved plan (-m/--message notes the release)
n8c types                               Generate n8c/n8c.types.ts (editor types; also run by pull)
n8c list [--full]                       Generation versions (releases), newest first
n8c create <workflow|prompt|credential|node> [--name --description --type --key --workflow]
n8c restore <generation> [--apply]      Roll every kind back to a generation version
n8c drop <generation...>                Delete generation versions from history (all kinds)
n8c db export [-o db.n8c-backup]        Dump all n8c collections (records + indexes) to a file   [MongoDB only]
n8c db import [file]                    Recreate + re-import collections from a backup file       [MongoDB only]
n8c mcp                                 Start an MCP (stdio) server exposing the loop as agent tools
```

**MongoDB-only commands.** `db export` / `db import` work on the MongoDB backend only. On the SQLite
backend the whole store is a single `.sqlite` file, so back it up by copying that file (and the
runtime **prompt-content** feature is disabled — see [Storage backends](#storage-backends)). Every
other command works on both backends.

Global flags: `-e, --env <name>` (overrides `defaultEnv`), `--pipe` (raw, unstyled output for
piping/parsing), and `--debug`. Active env = `-e/--env` > `defaultEnv` in `n8c.config.json` >
`"default"`. Every command self-documents via `--help`.

**`--debug`** logs every n8n API call to stderr — method, path, request body and response status —
so you can see exactly what n8c sends:

```
→ PATCH /api/v1/credentials/S3vU
{ "name": "Qdrant Api-key", "type": "httpHeaderAuth", "isPartialData": true,
  "data": { "name": "***", "value": "***" } }
← 400 {"message":"request.body.data requires property \"allowedDomains\""}
```

Secrets are **redacted, never printed**: values under a credential's `data` (and any secret-looking
key anywhere) become `***`, while the **key names are kept** — which is what you need to spot a
missing field like `allowedDomains`. The API key is never logged.

## Configuration

`n8c init` writes a fully explicit `n8c.config.json`:

```jsonc
{
  "database": "sqlite",        // default backend; "mongodb" for a shared/team store
  "sqlite": { "file": "n8c.sqlite" },
  "root": "n8c",
  "defaultEnv": "default",
  "n8nVersion": "3",           // "3" (default when absent): n8n 3.x and 2.33+; "2": n8n 2.x (see below); no 1.x
  "n8nProjectId": "",          // "" = the API key's default project
  "collectionPrefix": "n8c_",  // collectionPrefix/collections apply to the mongodb backend
  "collections": {
    "workflows": "n8c_workflows",
    "prompts": "n8c_prompts",
    "credentials": "n8c_credentials",
    "definitions": "n8c_definitions",
    "manifests": "n8c_manifests",
    "promptContents": "n8c_prompt_contents"
  },
  "credentials": { "encrypted": true }
}
```

Per-environment settings come from `.env`, `.env.<env>` files (never committed):

```
N8N_BASE=
N8N_API_KEY=
N8C_CREDENTIAL_ENCRYPTION_KEY=

# SQLITE_PATH=n8c.sqlite   # default backend; overrides sqlite.file in n8c.config.json

# Set "database": "mongodb" in n8c.config.json to use these instead:
# MONGO_URI=
# MONGO_DB=
```

## Deploy the same files to staging and prod

```bash
n8c -e staging pull        # n8n → DB → files (env-neutral UUIDs + per-env mapping) — commit n8c/
n8c -e prod pull           # on prod's fresh DB: builds prod's credential mapping
n8c -e prod plan           # preview what will change on prod
n8c -e prod apply          # push; localIds resolve to prod's n8n IDs
```

## Roadmap

Today n8c versions and deploys **workflows**, **prompts**, **credentials** and the runtime
**prompt-content** registry, and can scope to a single n8n project (`n8nProjectId`). Planned — to bring
the rest of an n8n instance under the same `plan` / `apply` / release / rollback model:

| Entity | Status | Notes |
|---|---|---|
| **Projects** | Planned | Manage projects and workflow/credential assignment (today: scope to one project). |
| **Variables** | Planned | Version & deploy n8n environment variables. |
| **Tags** | Planned | Workflow tags. |
| **Folders** | Planned | Workflow folders / organization. |
| **External secrets** | Exploring | External secret-store references. |
| **Users & roles (RBAC)** | Exploring | Users, roles and permissions. |
| **Data tables** | Exploring | n8n data tables. |

**A note on n8n editions & licensing.** Several of these — projects, variables, folders, external
secrets and RBAC — are **n8n Enterprise** features, exposed only on licensed editions and only where
n8n's **Public API** surfaces them. n8c manages each entity strictly through that official API and
does **not** work around n8n's [Sustainable Use License](https://docs.n8n.io/sustainable-use-license/);
availability therefore depends on your n8n edition. n8c itself is MIT-licensed and free to use.

## Cross-platform & Node versions

n8c is cross-platform (macOS, Linux, Windows) — all filesystem paths go through Node's `path` /
`url` helpers, so Windows drive letters and backslashes are handled correctly.

The one caveat is the **Node version**. The published package ships compiled JavaScript, but n8c
reads *your project's own* `apply.ts` entity files at runtime, which uses Node's native TypeScript
type stripping:

- **Node ≥ 22.18 or ≥ 23.6** — works out of the box (type stripping is on by default). This is the
  supported baseline (`engines.node >= 22.18`).
- **Node 22.6 – 22.17** — works only with the `--experimental-strip-types` flag.
- **Node < 22.6** — not supported.

## Architecture

[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) maps n8c's logic as mermaid diagrams: plan/apply,
destroy, the drift gate, credentials, storage, layouts, versions, prompts, pull and the MCP server.
The diagrams are maintained with the code: a change to a flow shown there updates its diagram in the
same PR (the same rule as the coverage gate).

## Development

n8c runs its own TypeScript sources directly in dev — no build needed:

```bash
npm start -- --help   # run the CLI from src/
node --test           # unit tests (in-memory store + fake n8n client)
npm run build         # compile src/ → dist/ (what gets published)
```

The **published package ships the compiled `dist/`** — Node disables type stripping for files under
`node_modules`, so the CLI can't run from raw `.ts` once installed. `prepublishOnly` runs the tests
and the build automatically. The unit tests cover the MongoDB adapter through an injected fake client
(`test/mongo-store.test.ts`); a real MongoDB server and a real n8n push are exercised only by manual runs
against live instances.

### Testing & coverage

```bash
npm test             # run the suite
npm run test:cov     # same, with coverage — FAILS below lines 100 / functions 100 / branches 98
```

`prepublishOnly` runs `npm run test:cov` before the build, so a release can't ship under the gate.
**Rule: every change keeps `npm run test:cov` green — new code ships with tests.**

Why branches is 98, not 100:

- The few uncovered branches are defensive fallbacks no caller can reach (e.g. `?.` / `??` on values
  every caller provides).
- Node merges per-test-file coverage in an order-dependent way, so the branch total jitters by up to
  about 0.3 percentage points between identical runs, and single files' branches flip too. A 100 gate
  would fail at random.
- On rare runs the line total can also dip a fraction of a percent below 100 even though every test passes
  (Node's merge of the per-process coverage reports occasionally loses part of one report). Re-run
  `npm run test:cov`, and treat it as real only if it repeats.

To find what is uncovered, emit an lcov report and look for zero hits:

```bash
node --test --experimental-test-coverage --test-coverage-include='src/**/*.ts' \
  --test-reporter=lcov --test-reporter-destination=lcov.info
grep -B8 'FNDA:0,' lcov.info    # uncovered functions (FN lines carry the names)
grep -E '^(SF|BRDA:[0-9]+,[0-9]+,[0-9]+,(0|-))' lcov.info   # uncovered branches per file
```

## License

[MIT](LICENSE) © ltmin

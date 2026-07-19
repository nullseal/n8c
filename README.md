# n8c

### Version control and a safety net for your n8n — built for the age of AI-edited workflows.

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

Runs its `.ts` sources directly on modern Node via native type stripping — **no build step**.

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
only [`mongodb`](https://www.npmjs.com/package/mongodb) (or built-in SQLite) and
[`commander`](https://www.npmjs.com/package/commander).

## Requirements

- **Node.js ≥ 22.18** (or ≥ 23.6) — n8c ships TypeScript sources and relies on Node's built-in type
  stripping, which is enabled by default from these versions. See
  [Cross-platform & Node versions](#cross-platform--node-versions).
- **A database** — either **MongoDB** (full-featured; a replica set is recommended so `apply` can
  snapshot atomically) or **SQLite** (a single local file, zero setup, via Node's built-in
  `node:sqlite`). See [Storage backends](#storage-backends).
- **n8n** with the **Public API** enabled (API 1.1.x) and an API key.

## Install

```bash
npm install -g n8c
# or, without a global install:
npx n8c --help
```

## Quickstart

```bash
# 1. Scaffold config, .env and .gitignore, and reconcile DB indexes.
n8c init

# 2. Fill in .env:  N8N_BASE, N8N_API_KEY, MONGO_URI, MONGO_DB,
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

`plan` computes actions against the **live** state (workflows and credentials diffed against the n8n
server, prompts against the DB), freezes them into `.states/n8c.state.<env>.json`, and `apply`
executes exactly that plan — pushing to n8n *before* committing the DB. `apply` refuses a stale plan
(files changed since `plan`). Use `n8c apply --force` to compute a fresh plan and apply it in one
step, Terraform-style.

- **Workflow `active` state is managed** — pulled, diffed, and reached via n8n's
  `activate` / `deactivate` endpoints.
- **Credentials reconcile in place** via `PATCH`, using the server's `updatedAt` as a change token —
  no duplicates; missing-on-server is recreated.
- **`plan --destroy`** marks workflows that exist on the server but not in your files; `apply`
  **archives** them (soft, recoverable) rather than hard-deleting.

### Pull & versioning

`pull` captures the current reality and leaves you with a clean baseline — running `plan` right
after a `pull` should report **no changes**:

- It records a new **version** (deduped against history — an unchanged re-pull adds nothing) and
  marks that version **active** (the `*` in `n8c list`), for every kind.
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

That makes rollback coherent. `n8c restore <generation>` rewrites the files for **every** kind back
to that release in one shot (add `--apply` to redeploy immediately). A ref that only identifies one
kind (a content checksum, or a kind-specific `pull` version) restores just that kind. An `apply`
that changes nothing creates no release (no empty generations).

To prune history, `n8c drop <ref...>` deletes one or more versions — a generation id drops from every
kind at once. Live docs are untouched. The **active** version can never be dropped (it's the deploy /
rollback baseline) — switch the baseline first with `restore` or a new `apply`, then drop the old one.

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

### n8n projects

By default n8c uses the API key's default (personal) project. If your workflows live in a **team
project**, set `n8nProjectId` in `n8c.config.json` — n8c then scopes `pull` / `plan` to that project,
creates new credentials in it, and transfers newly-created workflows into it.

## Storage backends

Set the backend with `database` in `n8c.config.json`.

| Feature | **`mongodb`** | **`sqlite`** |
|---|---|---|
| Setup | a running MongoDB server | a single local file, zero setup |
| Config | `MONGO_URI`, `MONGO_DB` in `.env` | `sqlite.file` in config, or `SQLITE_PATH` in `.env` (default `n8c.sqlite`) |
| Dependency | `mongodb` npm driver | Node's built-in `node:sqlite` (nothing to install) |
| Versioning, `plan` / `apply`, releases, `drop` | ✅ | ✅ |
| Multi-env credential mapping (`definitions`) | ✅ | ✅ |
| Concurrency | multi-writer — safe for a shared team/CI instance | single-writer — one machine / one file |
| Atomic `apply` snapshots | ✅ (replica set recommended) | ✅ (single-file transactions, always) |
| `db export` / `import` backup | ✅ | — (the `.sqlite` file *is* the backup — just copy it) |
| Runtime **prompt-content** feature | ✅ | **disabled** (see below) |
| Best for | teams, shared staging/prod, the runtime prompt registry | solo dev, a quick trial, a single instance, CI |

SQLite is the quickest way to try n8c or to version a single instance — no services, just Node's
built-in `node:sqlite`. MongoDB is the choice for a shared/team setup and is required if you use the
runtime prompt-content registry.

**Why prompt-content is disabled on SQLite.** The `prompt-contents` collection exists so an n8n
`load_prompts` node can read runtime prompts from the database *while a workflow executes*. n8n can
only reach MongoDB for that, so on SQLite the whole feature is switched off: `plan`, `apply`, `pull`
and `list` simply skip the `prompt-contents` kind (n8c prints a note on `init`). Everything else —
workflows, build-time prompts, credentials, versioning, `plan`/`apply` — works identically.

```jsonc
// n8c.config.json — SQLite backend
{ "database": "sqlite", "sqlite": { "file": "n8c.sqlite" } }
```

## Commands

```
n8c init [--project-only | --db-only]   Scaffold config/.env/.gitignore + reconcile DB indexes
n8c pull [--no-export]                  n8n + DB → files (--no-export = DB only)
n8c plan [--destroy]                    Diff files vs live → write .states/n8c.state.<env>.json
n8c apply [--force] [--destroy]         Execute the saved plan (--force = plan + apply in one step)
n8c list [--full]                       Version history for all kinds
n8c create <workflow|prompt|credential|node> [--name --description --type --key --workflow]
n8c restore <ref> [--apply]             Roll back all kinds to a release/version
n8c drop <ref...>                       Delete versions from history (generation → all kinds)
n8c db export [-o db.n8c-backup]        Dump all n8c collections (records + indexes) to a file   [MongoDB only]
n8c db import [file]                    Recreate + re-import collections from a backup file       [MongoDB only]
```

**MongoDB-only commands.** `db export` / `db import` work on the MongoDB backend only. On the SQLite
backend the whole store is a single `.sqlite` file, so back it up by copying that file (and the
runtime **prompt-content** feature is disabled — see [Storage backends](#storage-backends)). Every
other command works on both backends.

Global flags: `-e, --env <name>` (overrides `defaultEnv`) and `--pipe` (raw, unstyled output for
piping/parsing). Active env = `-e/--env` > `defaultEnv` in `n8c.config.json` > `"default"`.
Every command self-documents via `--help`.

## Configuration

`n8c init` writes a fully explicit `n8c.config.json`:

```jsonc
{
  "database": "mongodb",
  "root": "n8c",
  "defaultEnv": "default",
  "n8nProjectId": "",          // "" = the API key's default project
  "collectionPrefix": "n8c_",
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
MONGO_URI=
MONGO_DB=
N8C_CREDENTIAL_ENCRYPTION_KEY=
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

The one caveat is the **Node version**. n8c executes its own TypeScript sources at runtime, which
needs Node's native type stripping:

- **Node ≥ 22.18 or ≥ 23.6** — works out of the box (type stripping is on by default). This is the
  supported baseline (`engines.node >= 22.18`).
- **Node 22.6 – 22.17** — works only with the `--experimental-strip-types` flag.
- **Node < 22.6** — not supported.

## Development

```bash
node --test        # unit tests — no live services (in-memory store + a fake n8n client)
```

The MongoDB adapter and real n8n push are exercised by manual runs against a live instance, not by
the unit tests.

## License

[MIT](LICENSE) © ltmin

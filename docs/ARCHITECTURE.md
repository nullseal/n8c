# n8c architecture

These diagrams are maintained with the code: any PR that changes a flow shown here updates the diagram (same rule as the 100% coverage gate).

Every arrow is a real call or data flow in `src/`; dotted or dashed lines are not call arrows: diagram 12's dotted arrow is n8n reading
the DB (outside n8c), and dashed lines in diagrams 6, 9 and 10 are sequence replies or class relations. The **Source** line under each diagram names the files and functions it depicts;
re-check those when that code changes. The diagrams use Mermaid 11 syntax, which GitHub renders.

## Vocabulary

| Term | Meaning |
|---|---|
| kind | `workflows`, `credentials`, `prompts`, `promptContents` (folder `prompt-contents/`); one descriptor each in `src/entities/` |
| localId | env-neutral id of an entity: its folder name under `n8c/<kind>/`, never the n8n id |
| definitions | per-env mapping localId → n8n id (credentials: `{ id, name, updatedAt }`; workflows: the id string) |
| live doc | the last applied or pulled body of an entity, as stored in the DB |
| version, generation | a snapshot of one kind's live docs under a `versionId`; one apply or pull snapshots every kind under the same `versionId`, which `n8c list` shows as one generation |
| state file | `.states/n8c.state.json` (default env) or `.states/n8c.state.<env>.json`: the frozen plan, its server baseline and the apply result |

## Contents

1. [Command and data flow](#1-command-and-data-flow)
2. [Plan: workflow diff](#2-plan-workflow-diff)
3. [Apply and destroy](#3-apply-and-destroy)
4. [Credential secrets](#4-credential-secrets)
5. [Credential ids and node bindings](#5-credential-ids-and-node-bindings)
6. [Store](#6-store)
7. [Workflow layouts](#7-workflow-layouts)
8. [Versions and generations](#8-versions-and-generations)
9. [Drift gate](#9-drift-gate)
10. [MCP server](#10-mcp-server)
11. [Build and inline units](#11-build-and-inline-units)
12. [Prompts](#12-prompts)
13. [Pull and export](#13-pull-and-export)
14. [CLI commands and context](#14-cli-commands-and-context)
15. [n8n API clients (2.x / 3.x)](#15-n8n-api-clients-2x--3x)

## 1. Command and data flow

The plan → apply loop, and the pull and restore paths back to files. Each step is detailed in a later
diagram.

```mermaid
flowchart TB
    FILES["n8c/{kind}/{localId}/<br/>metadata.json + apply.ts"]
    UNITS["src/{unit}/<br/>Code-node units"]
    FILES --> RE["readEntity"]
    UNITS -->|"buildSources: codeByNode, used only by the<br/>staleness checksum (desiredBundleChecksum,<br/>recomputed by plan and by the apply<br/>handler files-unchanged check),<br/>NOT the plan diff or validateAll<br/>(known gap)"| CP
    UNITS -->|"codeByNode"| AFS
    RE -->|"apply re-reads files + codeByNode<br/>(desiredByKind)"| AFS
    RE --> VAL["validateAll"]
    RE --> BD["buildDocs:<br/>checksum + beforeSave"]
    VAL -->|"a problem<br/>refuses the plan"| CP["computePlan"]
    BD --> CP
    N8N[("n8n Public API")]
    subgraph db["Store: sqlite (default) or mongodb"]
        LIVE[("live docs")]
        DEFS[("definitions:<br/>localId to n8n id")]
        VERS[("versions +<br/>manifests")]
    end
    N8N -->|"workflows, credentials,<br/>baseline facts"| CP
    LIVE -->|"prompts, prompt-contents,<br/>credential checksums"| CP
    DEFS --> CP
    CP -->|"writeState"| STATE[".states/n8c.state.{env}.json"]
    STATE -->|"readState, then the<br/>files-unchanged check"| GATE["verifyBeforeApply<br/>(drift gate)"]
    N8N -->|"fresh facts"| GATE
    GATE -->|"block or stop"| HALT(["exit 1, nothing applied"])
    GATE -->|"proceed"| AFS["applyFromState"]
    CP -->|"apply --force:<br/>fresh plan, no gate"| AFS
    AFS -->|"push, archive, delete,<br/>activate, deactivate<br/>(n8nVersion 2: POST activate, deactivate,<br/>3: POST publish, unpublish,<br/>diagram 15)"| N8N
    AFS -->|"upsertLive, putLive"| LIVE
    AFS -->|"putDefinitions"| DEFS
    AFS -->|"createSnapshot +<br/>markActive"| VERS
    AFS -->|"state.applied"| CLI["CLI (cli.ts apply handler)"]
    CLI -->|"refreshed baseline +<br/>writeState"| STATE
    N8N -->|"listWorkflows,<br/>listCredentials"| PULL["n8c pull"]
    PULL -->|"putLive"| LIVE
    PULL -->|"putDefinitions"| DEFS
    PULL -->|"commitPullGeneration"| VERS
    PULL -->|"exportDocs"| FILES
    VERS -->|"n8c restore:<br/>exportVersion"| FILES
```

**Source:** `src/cli.ts` (plan, apply, pull, restore handlers), `src/engine/state.ts` (`computePlan`, `writeState`, `readState`, `desiredBundleChecksum`), `src/engine/apply-state.ts` (`applyFromState`), `src/engine/verify.ts` (`verifyBeforeApply`, `refreshedServerFacts`), `src/engine/apply.ts` (`buildDocs`), `src/engine/validate.ts` (`validateAll`), `src/layout.ts` (`readEntity`), `src/engine/build.ts` (`buildSources`), `src/engine/pull.ts`, `src/engine/pull-prompts.ts`, `src/engine/transfer.ts` (`exportDocs`, `exportVersion`).

## 2. Plan: workflow diff

`planAgainstServer` diffs each workflow file against the live n8n body (`planDiff` compares nodes,
then pushed fields, then the active flag); `computePlan` turns the rows into plan resources.
Credentials and prompts are planned differently (diagrams 5 and 12).

```mermaid
flowchart TD
    PAS["planAgainstServer"] --> DES["desired =<br/>buildDocs(workflows)"]
    PAS --> SRV["server = workflow.pullFromServer<br/>listWorkflows. localId =<br/>meta.n8cLocalId, else the env<br/>mapping, else a new UUID"]
    PAS --> CM["credMap = credIdMap(<br/>credential definitions)"]
    DES --> HAS{"server body with<br/>the same localId?"}
    SRV --> HAS
    SRV -->|"no file has<br/>its localId"| REM["removed: carries<br/>archived + serverId"]
    HAS -->|"no"| NEW["new: every node new<br/>setActive true if the<br/>file sets active"]
    HAS -->|"yes"| NORM["normalizeCredentials, both sides:<br/>desired ids via credMap,<br/>server ids as-is, each<br/>binding becomes credentialId"]
    CM --> NORM
    NORM --> DN["diffNodes: match by id,<br/>else name, compare<br/>node checksums"]
    DN --> DPF["diffPushedFields over name,<br/>description, connections,<br/>settings, nodeGroups<br/>(not nodes, not staticData)"]
    DPF --> UND{"value set<br/>in the file?"}
    UND -->|"no"| SKIP["skipped:<br/>never a change"]
    UND -->|"settings"| SET["each WRITABLE_SETTINGS<br/>key the file sets:<br/>settings.KEY if<br/>checksums differ"]
    UND -->|"description"| DESC["description if it differs<br/>with the [n8c-managed]<br/>marker stripped<br/>on both sides"]
    UND -->|"name, connections,<br/>nodeGroups"| OTH["the field name<br/>if checksums differ"]
    SKIP --> ACT
    SET --> ACT
    DESC --> ACT
    OTH --> ACT
    ACT["activeChanged: the file's<br/>active flag differs<br/>from the server's"] --> DEC{"a node not identical,<br/>a field reported,<br/>or activeChanged?"}
    DEC -->|"yes"| CHG["changed: nodes + fields,<br/>setActive = file value<br/>if activeChanged"]
    DEC -->|"no"| IDN["identical"]
    NEW --> ROW{"computePlan:<br/>row to resource"}
    CHG --> ROW
    IDN --> ROW
    REM --> ROW
    ROW -->|"removed,<br/>no --destroy"| ORPH["orphan: reported,<br/>labelled when<br/>already archived"]
    ROW -->|"removed,<br/>--destroy"| DEL["delete with archived<br/>+ serverId (diagram 3)"]
    ROW -->|"archived<br/>on n8n"| IGN["noop: n8n rejects<br/>updates, listed as<br/>ignored when changed"]
    ROW -->|"otherwise"| ACTN["new: create<br/>changed: update<br/>identical: noop"]
```

- `checksum()` sorts keys and drops `id`, `createdAt`, `updatedAt` and `versionId` at every depth, so a
  binding compared under `id` would vanish. That is why `normalizeCredentials` emits `credentialId`.
- `diffNodes` compares the normalized bodies; `diffPushedFields` compares the raw ones.
- `plan` prints the reported fields, then the changed node names (`renderChangedParts` in `cli.ts`).

**Source:** `src/engine/plan.ts` (`planAgainstServer`, `planDiff`, `normalizeCredentials`, `diffPushedFields`), `src/engine/apply.ts` (`diffNodes`, `buildDocs`), `src/entities/workflow.ts` (`pullFromServer`, `WRITABLE`, `WRITABLE_SETTINGS`), `src/engine/cred-map.ts` (`credIdMap`), `src/layout.ts` (`stripManagedMarker`), `src/checksum.ts`, `src/engine/state.ts` (`computePlan`, workflows block).

## 3. Apply and destroy

`applyFromState` runs the saved plan row by row: push to n8n first, then commit the DB, so a failed
push never leaves the DB claiming success. Kinds run in a fixed order, so credentials are mapped before
the workflows that reference them. A failing row is recorded and the loop continues.

```mermaid
stateDiagram-v2
    direction TB
    state "For each kind with non-noop rows, in order: credentials, prompts, promptContents (when enabled), workflows" as Kinds {
        state "Load the kind<br/>desired = desiredByKind (files + codeByNode)<br/>mapping = getDefinitions(env, kind)" as Load
        state "For each non-noop row" as Rows {
            state action <<choice>>
            state "Delete" as Delete {
                state "Resolve the n8n id<br/>workflows: mapping, else the plan's serverId<br/>credentials: the mapping's id<br/>prompts, promptContents: none" as Resolve
                state target <<choice>>
                state "archiveWorkflow<br/>round 1: soft, recoverable" as Archive
                state "deleteWorkflow<br/>round 2: permanent" as Purge
                state "deleteCredential<br/>permanent" as DelCred
                state "Forget it locally<br/>remove the mapping entry<br/>putLive(kind, live docs minus this one)" as Forget
                [*] --> Resolve
                Resolve --> target
                target --> Archive : live workflow
                target --> Purge : archived workflow
                target --> DelCred : mapped credential
                target --> Forget : no id, or no n8n client
                Archive --> Forget : done, or 404
                Purge --> Forget : done, or 404
                DelCred --> Forget : done, or 404
                Forget --> [*]
            }
            state "Create or update" as Upsert {
                state serverKind <<choice>>
                state "pushToServer(doc, new or changed)<br/>merge the returned ids into mapping" as Push
                state "activateWorkflow or deactivateWorkflow<br/>n8nVersion 2: POST activate or deactivate<br/>n8nVersion 3: POST publish or unpublish" as SetActive
                state "upsertLive(kind, doc)" as Commit
                [*] --> serverKind
                serverKind --> Push : workflows or credentials, n8n client set
                serverKind --> Commit : DB-only kind, or no n8n client
                Push --> SetActive : workflow row with setActive
                Push --> Commit : otherwise
                SetActive --> Commit
                Commit --> [*]
            }
            state "row ok" as Ok
            state "row failed, error recorded" as Failed
            [*] --> action
            action --> Delete : delete
            action --> Upsert : create or update, doc found
            action --> Failed : desired doc missing
            Delete --> Ok
            Upsert --> Ok
            Delete --> Failed : a step throws, n8n 404 counts as done
            Upsert --> Failed : a step throws
            Ok --> [*]
            Failed --> [*]
        }
        state saved <<choice>>
        state "putDefinitions(env, kind, mapping)" as SaveDefs
        [*] --> Load
        Load --> Rows
        Rows --> saved
        saved --> SaveDefs : a row succeeded
        saved --> [*] : no row succeeded
        SaveDefs --> [*]
    }
    state anyChange <<choice>>
    state "One release: each kind with live docs<br/>createSnapshot(generation) + markActive" as Release
    state "CLI: refreshedServerFacts" as Refresh
    state "writeState<br/>applied result + fresh baseline" as Saved
    state "writeState<br/>no baseline, serverListed false" as Blind
    [*] --> Kinds : applyFromState
    Kinds --> anyChange
    anyChange --> Release : something changed
    anyChange --> Refresh : nothing changed
    Release --> Refresh
    Refresh --> Saved : facts read
    Refresh --> Blind : read failed
    Saved --> [*]
    Blind --> [*] : the next apply of this plan stops at the drift gate
```

- Removing a workflow that has no file takes two `--destroy` rounds. Round 1 archives a live workflow
  (recoverable); n8n keeps listing it, so the next `plan --destroy` plans it again with
  `archived: true`, and round 2 deletes it permanently. A workflow made in the n8n UI has no mapping,
  so its id is the `serverId` the plan recorded.
- Credentials are deleted permanently in one round; prompts and prompt-contents only leave the DB.
- The refresh and `writeState` steps belong to the CLI (`apply`, and `restore --apply`); `apply` exits 1
  when any row failed.

**Source:** `src/engine/apply-state.ts` (`applyFromState`), `src/engine/state.ts` (`activeKinds`, `desiredByKind`), `src/entities/workflow.ts` and `src/entities/credential.ts` (`pushToServer`), `src/n8n/base.ts` (`archiveWorkflow`, `deleteWorkflow`, `deleteCredential`), `src/n8n/v2.ts` and `src/n8n/v3.ts` (`activateWorkflow`, `deactivateWorkflow`), `src/engine/verify.ts` (`refreshedServerFacts`), `src/cli.ts` (apply and restore handlers).

## 4. Credential secrets

A credential file references its secret as `process.env.NAME`, and the value is resolved when the file
is imported. No secret is ever written to a file. The DB stores the resolved secret, encrypted unless
`credentials.encrypted` is `false` in `n8c.config.json`.

```mermaid
flowchart TD
    ENVF[".env or .env.{env}"] -->|"loadEnv"| CTX["buildContext: each key is<br/>copied into process.env unless<br/>the shell already set it"]
    FILE["n8c/credentials/{localId}/apply.ts<br/>data: token = process.env.MY_TOKEN"] -->|"readEntity imports<br/>the module"| BODY["body.data holds<br/>the resolved secret"]
    CTX --> BODY
    BODY --> VAL{"validateAll"}
    VAL -->|"a data value<br/>is undefined"| E1["plan refused: is the<br/>referenced environment<br/>variable set?"]
    VAL -->|"encryption on,<br/>data present, no<br/>N8C_CREDENTIAL_ENCRYPTION_KEY"| E2["plan refused:<br/>key required"]
    BODY --> SUM["buildDocs: checksum<br/>over the plaintext body"]
    SUM --> BSV{"beforeSave:<br/>encryption on and<br/>data present?"}
    BSV -->|"yes"| ENC["encryptSecret: AES-256-GCM,<br/>scrypt key, random salt and IV,<br/>stored as v1:salt:iv:tag:data"]
    BSV -->|"no: encryption off,<br/>or no data"| PLAIN["body kept as is"]
    ENC --> DOC["desired doc"]
    PLAIN --> DOC
    DOC -->|"apply: pushToServer<br/>calls beforePush"| DEC["decryptCredentialData<br/>(key required if encrypted)"]
    DEC --> UP{"mapped id and<br/>plan action update?"}
    UP -->|"yes"| HD{"data present?"}
    HD -->|"no"| P0["PATCH name, type,<br/>isPartialData<br/>stored secret untouched"]
    HD -->|"yes"| SW1["sendWithSchemaDefaults:<br/>PATCH with data"]
    SW1 -->|"a required field<br/>has no default"| P1["PATCH again without data<br/>warning: secret NOT updated"]
    UP -->|"no"| SW2["sendWithSchemaDefaults:<br/>POST name, type, data or empty,<br/>+ projectId when set"]
    SW2 -->|"a required field<br/>has no default"| E3["row fails: a create<br/>needs complete data"]
    P0 --> RES["mapping entry:<br/>id, name, updatedAt"]
    SW1 --> RES
    P1 --> RES
    SW2 --> RES
    RES -->|"putDefinitions"| DEFS[("credential definitions")]
    DOC -->|"after a successful<br/>push: upsertLive"| LIVE[("credentials live doc")]

    LIST[("n8n listCredentials<br/>id, name, type, updatedAt,<br/>never data")] -->|"n8c pull"| PB["pulled body:<br/>name, type"]
    PB --> EXP["exportDocs:<br/>decryptCredentialData,<br/>then credentialSource"]
    VDOC[("version docs")] -->|"n8c restore"| EXP
    EXP --> OUTF["apply.ts: name, type and a<br/>commented data hint, no secret"]
```

- `sendWithSchemaDefaults` sends, and when n8n answers that fields are missing (`requires property "X"`)
  it fills each one from n8n's own default for the type (`getCredentialSchema` → `collectFieldDefaults`,
  cached per context), else from n8c's `allowedDomains: "*"`, and retries, up to 6 tries. A field with no
  default anywhere ends the loop; any other error is rethrown and worded by `explainCredentialError`.
- The export decrypts the stored body but writes only `name` and `type`; restoring a version whose
  credential data is encrypted therefore needs the key.

**Source:** `src/context.ts` (`buildContext`), `src/env.ts` (`loadEnv`), `src/layout.ts` (`readEntity`), `src/engine/validate.ts` (`validateAll`, rule 4 and the key check), `src/engine/apply.ts` (`buildDocs`), `src/entities/credential.ts` (`beforeSave`, `beforePush`, `decryptCredentialData`, `pushToServer`, `sendWithSchemaDefaults`, `fillMissingFields`, `credentialFieldDefaults`, `explainCredentialError`, `pullFromServer`), `src/crypto.ts`, `src/engine/types-gen.ts` (`collectFieldDefaults`), `src/engine/transfer.ts` (`exportDocs`, `credentialSource`), `src/n8n/base.ts` (`createCredential`, `updateCredential`, `getCredentialSchema`), `src/engine/apply-state.ts`.

## 5. Credential ids and node bindings

Files only ever hold credential localIds. Each env's definitions map them to n8n ids; the plan, the
push and the export each translate through that mapping.

```mermaid
flowchart TD
    PF["pull: credential.pullFromServer<br/>listCredentials, resolveCredLocalId:<br/>the known localId (credIndex),<br/>else a new UUID"]
    MW["pull: mapCredentialsFromWorkflows<br/>credential refs on every<br/>workflow node"]
    AP["apply: ids returned by<br/>pushToServer, deleted<br/>rows removed"]
    DEFS[("credential definitions, per env<br/>localId to id, name, updatedAt<br/>normalized on write: one<br/>localId per n8n id")]
    PF -->|"putDefinitions<br/>(replaces)"| DEFS
    MW -->|"putDefinitions<br/>(merged: each entry rewritten to<br/>id + node reference name<br/>(the stored name if the reference has none),<br/>stored updatedAt dropped)"| DEFS
    AP -->|"putDefinitions"| DEFS

    subgraph PLAN["plan: one credential file"]
        M{"mapped?"}
        L{"listCredentials<br/>succeeded?"}
        S{"mapped id<br/>still on n8n?"}
        D{"name or type differs,<br/>n8n updatedAt differs<br/>from the mapped one<br/>(inert when the mapping has no<br/>updatedAt, e.g. after a pull),<br/>or the file differs from<br/>the live doc (or none)?"}
        F{"file differs from<br/>the live doc<br/>(or none)?"}
        CREATE["create"]
        UPDATE["update (PATCH)"]
        NOOP["noop"]
        M -->|"no"| CREATE
        M -->|"yes"| L
        L -->|"no"| F
        L -->|"yes"| S
        S -->|"no"| CREATE
        S -->|"yes"| D
        D -->|"yes"| UPDATE
        D -->|"no"| NOOP
        F -->|"yes"| UPDATE
        F -->|"no"| NOOP
    end
    DEFS --> M
    DEFS --> GONE["live doc or mapping<br/>without a file: orphan,<br/>or with --destroy a delete"]

    subgraph BIND["Workflow node bindings, in pipeline order"]
        NF["workflow file: node credentials<br/>TYPE: id = credential localId"]
        V["validateAll: each id is mapped<br/>or has a credentials/ folder"]
        N["plan: normalizeCredentials,<br/>credentialId = mapped n8n id,<br/>diffed against the server's"]
        B["apply: workflow.beforePush<br/>id + name from the mapping,<br/>unmapped: missing credential mapping"]
        NF --> V --> N --> B
    end
    DEFS --> V
    DEFS --> N
    DEFS --> B
    DEFS --> X["pull, restore: exportDocs<br/>n8n id to localId via credIndex,<br/>unmapped: export fails,<br/>environment.json lists the<br/>mapped credentials the workflow uses"]
    X -->|"writes"| NF
```

- The pull writes the credential mapping with replace semantics from `listCredentials`, which only sees
  credentials the API key can reach; `mapCredentialsFromWorkflows` then merges every node reference back
  in, so a credential from another n8n project still resolves on export. The merge (`resolveCredLocalId`)
  rewrites each existing entry to `{ id, name }` (the node reference's name, falling back to the stored name when the reference has none), discarding the `updatedAt` the
  credential pull just stored, so the plan's "n8n updatedAt differs" check is inert after a pull for every
  node-referenced credential until n8c next pushes it (known bug, being fixed separately).
- `apply` runs the credentials kind first and saves its mapping before workflows push, so
  `workflow.beforePush` can bind a credential created in the same apply.

**Source:** `src/engine/cred-map.ts` (`credIndex`, `credIdMap`, `resolveCredLocalId`, `normalizeMapping`), `src/entities/credential.ts` (`pullFromServer`, `pushToServer`), `src/engine/environment.ts` (`mapCredentialsFromWorkflows`), `src/engine/pull.ts` (`pullEntity`), `src/engine/state.ts` (credentials block of `computePlan`), `src/engine/validate.ts`, `src/engine/plan.ts` (`normalizeCredentials`), `src/entities/workflow.ts` (`beforePush`), `src/engine/transfer.ts` (`exportDocs`), `src/engine/materialize.ts` (`relinkCredentials`), `src/engine/apply-state.ts`.

## 6. Store

One `Store` interface; `createStore` picks the adapter from `database` in `n8c.config.json`.

```mermaid
classDiagram
    direction TB
    class Store {
        <<interface>>
        +capabilities promptContents, backup
        +getLive(kind)
        +putLive(kind, docs, session)
        +upsertLive(kind, docs, session)
        +createSnapshot(kind, versionId, docs, ...)
        +listVersions(kind)
        +getVersion(kind, versionId)
        +markActive(kind, versionId, session)
        +dropVersion(kind, versionId, session)
        +putDefinitions(env, kind, mapping, session)
        +getDefinitions(env, kind)
        +withTransaction(fn)
        +init()
        +backupDb() BackupDb
        +close()
    }
    class createStore {
        <<factory>>
        mongodb needs MONGO_URI, MONGO_DB
        sqlite file = SQLITE_PATH,
        else sqlite.file, else n8c.sqlite
        any other value throws
    }
    class MongoStore {
        capabilities promptContents, backup
        collections, PREFIX default n8c_
        PREFIX workflows, prompts,
        credentials, prompt_contents hold
        live docs, mode live, and version
        docs tagged versionId
        PREFIX manifests, one doc per
        kind and versionId
        PREFIX definitions, one doc per
        env, kind, localId, n8nId unique
        transactions use a Mongo session
        init checks for a replica set
    }
    class SqliteStore {
        capabilities none
        one node sqlite file, WAL mode
        table live, key kind + localId
        table versions, kind + versionId
        table manifests, key kind + versionId
        table definitions, key env, kind,
        localId, n8nId unique
        BEGIN, COMMIT, ROLLBACK, nested
        calls join the outer one
        init creates the tables
        backupDb throws
    }
    class MemoryStore {
        capabilities promptContents
        in-memory maps, tests only
        backupDb throws
    }
    class BackupDb {
        <<interface>>
        +names()
        +find(name)
        +listIndexes(name)
        +recreate(name)
        +insert(name, docs)
        +createIndex(name, index)
    }
    Store <|.. MongoStore
    Store <|.. SqliteStore
    Store <|.. MemoryStore
    createStore ..> MongoStore : database mongodb
    createStore ..> SqliteStore : database sqlite
    MongoStore ..> BackupDb : backupDb
```

| | MongoStore | SqliteStore | MemoryStore |
|---|---|---|---|
| `capabilities.promptContents` | `true` | `false` (the engine skips the kind) | `true` |
| `capabilities.backup` | `true` | `false` | `false` |
| `backupDb()` (`db export` / `db import`) | adapter over the collections | throws | throws |
| built by `createStore` | `database: "mongodb"` | `database: "sqlite"` (the default) | never (tests only) |

- Only `capabilities.promptContents` is read by the engine (through `ctx.promptContentsEnabled`);
  `db export` / `db import` call `backupDb()` directly and rely on it throwing.
- MongoStore specifics: `putLive` and `upsertLive` store `liveStorageDoc` (promptContents bodies are
  spread to the top level); `getLive` rebuilds those bodies, even for externally seeded docs;
  `getVersion` falls back to legacy manifest-embedded docs (`selectVersionDocs`); `getDefinitions`
  also reads the legacy single-doc mapping.
- Every `putDefinitions` replaces the `{env, kind}` mapping and normalizes it (`mappingRows` /
  `normalizeMapping`), so each n8n id maps to exactly one localId, UUID-shaped preferred.
- `PREFIX` is `collectionPrefix` (default `n8c_`); any single name can be overridden through
  `collections` (`resolveCollections`). The sqlite table names are fixed.
- `sqlite-quiet.ts` is imported before `node:sqlite` loads, to silence its experimental warning.

**Source:** `src/store/store.ts`, `src/store/factory.ts` (`createStore`), `src/store/mongo.ts`, `src/store/sqlite.ts`, `src/store/sqlite-quiet.ts`, `src/store/memory.ts`, `src/store/collections.ts` (`resolveCollections`, `collectionForKind`), `src/store/live-doc.ts` (`liveStorageDoc`), `src/store/version-docs.ts` (`selectVersionDocs`), `src/engine/cred-map.ts` (`mappingRows`, `normalizeMapping`), `src/engine/backup.ts` (`dumpBackup`, `restoreBackup`), `src/context.ts`.

## 7. Workflow layouts

A workflow folder is read in one of two layouts. In the flat one `apply.ts` owns the body; in the
exploded one (a `nodes/` folder) the body is assembled from `metadata.json` and per-node files.

```mermaid
flowchart TD
    W1["pull, restore: exportDocs writes flat:<br/>metadata.json with the name +<br/>apply.ts from materializeWorkflowSource"]
    W2["n8c create workflow: flat scaffold<br/>n8c create node: adds nodes/{uuid}/<br/>with metadata.json, apply.ts,<br/>code.ts, connection.ts"]
    W1 --> RE
    W2 --> RE
    RE["readEntity(root, kind, localId,<br/>codeByNode): reads metadata.json"] --> Q{"workflows kind and<br/>a nodes/ folder?"}
    Q -->|"no: flat"| FA["import the apply.ts default<br/>export: a value, or a function<br/>called and awaited"]
    FA --> FDESC{"body has no description<br/>but metadata.json has one?"}
    FDESC -->|"yes"| FCOPY["copy it into the body"]
    FDESC -->|"no"| FBODY["body = what apply.ts returns<br/>metadata.json supplies<br/>the display name"]
    FCOPY --> FBODY
    Q -->|"yes: exploded"| EACH["each nodes/{nodeId}/ folder<br/>metadata.json: name, type,<br/>typeVersion, position, credentials<br/>apply.ts: parameters<br/>code.ts: jsCode (diagram 11)<br/>credentials.ts: TYPE to localId<br/>prompt.ts: for validateAll (diagram 12)<br/>connection.ts: outgoing connections"]
    EACH --> NODEOBJ["node: id = nodeId,<br/>notes = n8c@nodeId"]
    EACH --> CONN["connections: metadata.json ones<br/>keyed by nodeId, connection.ts<br/>wins for its node, target<br/>nodeIds resolved to names"]
    CONN --> CCHK{"validateAll: each<br/>metadata.json connection<br/>end a known node id?"}
    CCHK -->|"no"| REFUSE2["plan refused:<br/>not a known node"]
    NODEOBJ --> EBODY["body = workflow metadata.json<br/>fields except connections<br/>+ nodes + connections"]
    CONN --> EBODY
    EBODY --> MARK["description gets the<br/>[n8c-managed] marker<br/>when missing"]
    FBODY --> NAMECHK{"validateAll: body name and<br/>metadata.json name both<br/>set and different?"}
    MARK --> NAMECHK
    NAMECHK -->|"yes, flat only:<br/>exploded takes its name<br/>from metadata.json"| REFUSE["plan refused: name<br/>mismatch, rename<br/>in both files"]
    NAMECHK -->|"no"| OUT["workflow body<br/>for buildDocs"]
```

- In the exploded layout, a `credentials.ts` replaces the node's `metadata.json` credentials.

**Source:** `src/layout.ts` (`readEntity`, `writeEntity`, `MANAGED_MARKER`), `src/engine/validate.ts` (`validateAll` rules 0 and 3), `src/engine/transfer.ts` (`exportDocs`), `src/engine/materialize.ts` (`materializeWorkflowSource`), `src/engine/generate.ts` (`createEntity`).

## 8. Versions and generations

Every apply that changes something, and every pull that finds a difference, writes one generation: all
kinds snapshotted under one `versionId`. `list`, `restore` and `drop` address generations, never a
single kind.

```mermaid
flowchart TD
    subgraph WRITE["Writing a generation"]
        AP["apply: applyFromState<br/>starts"] --> G1["generation = nextVersionId<br/>minted at apply start,<br/>used only if something changed<br/>(ISO timestamp, strictly increasing)"]
        G1 --> SNAP["each kind with live docs:<br/>createSnapshot(kind, generation,<br/>live docs, bundle checksum,<br/>message) + markActive"]
        PL["pull: a kind's checksum<br/>differs from the<br/>active generation"] --> G2["commitPullGeneration<br/>(nextVersionId)"]
        G2 --> SNAP2["each non-empty pulled kind:<br/>createSnapshot + markActive"]
    end
    subgraph LIST["n8c list"]
        RG["readGenerations: listVersions<br/>per kind (promptContents<br/>only when enabled)"] --> GB["groupByGeneration:<br/>group by versionId,<br/>members = kind + checksum,<br/>active if any member is,<br/>first message wins"]
        GB --> H["hash = checksum of versionId<br/>+ sorted kind:checksum<br/>(unique even when<br/>content repeats)"]
        H --> SORT["newest first,<br/>renderGeneration,<br/>active marked with *"]
    end
    SNAP --> RG
    SNAP2 --> RG
    H -->|"restore and drop<br/>resolve refs here"| R1
    H --> D1
    subgraph RESTORE["n8c restore REF"]
        R1["resolveGenerationRef: trim,<br/>drop a trailing colon, exact<br/>versionId, else a unique hash<br/>prefix (else an error)"] --> R2["each kind holding<br/>that versionId: exportVersion<br/>= getVersion + exportDocs<br/>(files rewritten)"]
        R2 --> R3{"--apply?"}
        R3 -->|"no"| R4["files only: plan and<br/>apply next (active<br/>generation unchanged)"]
        R3 -->|"yes"| R5["computePlan (no --destroy),<br/>writeState, applyFromState<br/>(message restore REF),<br/>refreshedServerFacts, writeState<br/>no drift gate, a change<br/>makes a new generation"]
    end
    subgraph DROP["n8c drop REF..."]
        D1["resolveGenerationRef<br/>for each ref"] --> D2{"a target<br/>is active?"}
        D2 -->|"yes"| D3["error: make another<br/>generation active first"]
        D2 -->|"no"| D4["each kind of the generation:<br/>dropVersion (manifest +<br/>version docs), live<br/>docs untouched"]
    end
```

**Source:** `src/engine/apply-state.ts` (pass 2), `src/engine/pull.ts` (`commitPullGeneration`), `src/version.ts` (`nextVersionId`), `src/cli.ts` (`readGenerations`, `groupByGeneration`, `resolveGenerationRef`, `renderGeneration`; list, pull, restore and drop handlers), `src/engine/list.ts` (`listEntity`), `src/engine/transfer.ts` (`exportVersion`), `src/store/*` (`createSnapshot`, `markActive`, `listVersions`, `getVersion`, `dropVersion`).

## 9. Drift gate

`plan` records a baseline of the instance; `apply` re-reads it and refuses when something the plan is
about to write changed on n8n in the meantime.

```mermaid
sequenceDiagram
    autonumber
    actor Op as Operator
    participant CLI as n8c CLI
    participant CP as computePlan
    participant V as verify.ts
    participant N as n8n API
    participant SF as State file

    Op->>CLI: n8c plan
    CLI->>CP: computePlan
    CP->>CP: validateAll, any problem throws
    CP->>N: listCredentials
    alt listing fails
        CP-->>CLI: onCredentialsListError(message)
        Note over CP: no baseline read,<br/>serverFacts stays unset
    else listing succeeds
        CP->>V: readServerFacts,<br/>reusing the credential list
        V->>N: listWorkflows
        V-->>CP: facts per id: updatedAt + active,<br/>or updatedAt + name + type
        Note over CP: if this read throws,<br/>serverFacts stays unset
    end
    CP->>CP: diff prompts, credentials, workflows
    CP-->>CLI: state, serverListed =<br/>listed and serverFacts set
    CLI->>SF: writeState
    Note over CLI: serverListed false: plan says why. Only a failed<br/>baseline read prints that apply will refuse,<br/>a failed credential listing prints a<br/>local-DB-only warning

    Op->>CLI: n8c apply
    CLI->>SF: readState
    CLI->>CLI: files changed since plan? throw
    opt n8n configured, no --no-verify, no --force
        CLI->>V: verifyBeforeApply(state)
        V->>N: readServerFacts<br/>(listWorkflows, listCredentials)
        V->>V: getDefinitions,<br/>workflows + credentials
        alt a read fails
            V-->>CLI: stop
        else no serverFacts, serverListed false
            V-->>CLI: stop, re-run n8c plan
        else no serverFacts, legacy state file
            V-->>CLI: proceed, with a notice
        else a written entity changed or vanished
            V-->>CLI: block, with the drift list
        else
            V-->>CLI: proceed
        end
        Note over V: touched = non-noop workflow and<br/>credential rows with an n8n id<br/>(mapping, else the plan's serverId).<br/>An id missing from the baseline<br/>is a create, not drift.
        Note over CLI: stop or block: print the reason,<br/>exit 1, apply nothing
    end
    CLI->>SF: writeState(state)
    CLI->>CLI: applyFromState,<br/>may fail partially
    CLI->>V: refreshedServerFacts
    V->>N: listWorkflows, listCredentials
    V-->>CLI: fresh facts, or<br/>undefined on any error
    CLI->>SF: writeState with the fresh facts<br/>(serverListed false if the refresh failed)
```

The baseline is refreshed after every apply, even a partial one, so a retry does not see this apply's
own writes as drift. `apply --force` plans fresh and skips the gate.

**Source:** `src/engine/state.ts` (`computePlan`), `src/engine/verify.ts` (`readServerFacts`, `verifyBeforeApply`, `touchedFromState`, `driftFor`, `refreshedServerFacts`), `src/cli.ts` (plan and apply handlers).

## 10. MCP server

`n8c mcp` speaks MCP over stdio and runs each tool call as a real CLI child process, one at a time.

```mermaid
sequenceDiagram
    autonumber
    participant C as MCP client
    participant S as startMcpServer
    participant Q as Line queue
    participant H as handleMessage
    participant R as spawnCliRunner
    participant X as n8c CLI child

    C->>S: stdin chunk,<br/>any number of lines
    S->>S: splitLines keeps an<br/>unterminated tail in buf.rest
    loop every complete line
        S->>Q: enqueue(line),<br/>tail = the queue promise
    end
    Note over Q: a line starts only after<br/>the previous one settled.<br/>A failure is swallowed so<br/>the queue keeps going.
    Q->>Q: JSON.parse, a line that<br/>is not JSON is skipped
    Q->>H: handleMessage(msg)
    alt no id (a notification)
        H-->>Q: no response
    else initialize, ping or tools/list
        H-->>Q: serverInfo, an empty<br/>result, or MCP_TOOLS
    else tools/call
        H->>H: toolArgv(name, arguments)
        Note over H: allowlist only:<br/>pull -y, plan [--destroy],<br/>apply [-m], list [--full],<br/>restore GEN [--apply],<br/>plus -e ENV, always --pipe.<br/>An unknown tool, or a<br/>generation starting<br/>with -, throws.
        H->>R: run(argv)
        R->>X: spawn(process.execPath,<br/>cliPath + argv), stdin ignored
        X-->>R: stdout + stderr text,<br/>exit code
        R-->>H: text, ok when the<br/>exit code is 0
        H-->>Q: result text, isError when<br/>not ok or toolArgv threw
    else any other method
        H-->>Q: error -32601,<br/>method not found
    end
    Q->>C: stdout, one JSON line
    C->>S: stdin EOF
    S->>S: wait for the queue tail,<br/>then exit 0
```

**Source:** `src/mcp/server.ts` (`startMcpServer`, `splitLines`, `makeLineHandler`, `spawnCliRunner`), `src/mcp/protocol.ts` (`handleMessage`, `toolArgv`, `MCP_TOOLS`), `src/cli.ts` (`mcp` command).

## 11. Build and inline units

Code-node source is written as TypeScript and inlined into one self-contained `jsCode` string, since
an n8n Code node cannot import. There are two sources: project units under `src/` that target a node
id, and the `code.ts` of a node in an exploded workflow.

```mermaid
flowchart TD
    subgraph SRC["Project units: src/{unit}/"]
        UMETA["metadata.json<br/>target = node id"]
        UCODE["code.ts +<br/>relative helpers"]
    end
    NCODE["exploded workflow node:<br/>nodes/{nodeId}/code.ts"]
    UMETA --> BS["buildSources(project dir)"]
    UCODE --> BS
    BS -->|"no metadata.target"| THROW
    BS -->|"inlineUnit(unit dir)"| V
    NCODE --> FORM{"readEntity: a line<br/>starting with export?"}
    FORM -->|"yes: module form"| MOD["import the default export<br/>(a function is called),<br/>must be a string"]
    FORM -->|"no: raw Code-node body"| V
    subgraph INLINE["inlineUnit(dir)"]
        V["visit code.ts depth-first,<br/>parseImports per file"]
        V -->|"relative named import"| RD["resolveDep: the path if it<br/>ends in .ts, else path + .ts,<br/>else the path"]
        RD -->|"visit the helper first"| V
        V --> ORD["helpers in<br/>dependency-first order"]
        ORD --> TH["transformHelper per helper:<br/>strip types, reject export default,<br/>drop imports, export keywords<br/>and export lists"]
        TH --> TE["transformEntry: drop imports,<br/>wrap in an async function,<br/>strip types, unwrap<br/>(top-level return allowed)"]
        TE --> JOIN["join helpers + entry"]
    end
    V -->|"bare package specifier,<br/>default or namespace import,<br/>or an import cycle"| THROW["throw: fail loud"]
    RD -->|"not found"| THROW
    JOIN -->|"an import or<br/>export left over"| THROW
    JOIN -->|"returned to buildSources"| BOUT["dist/{unit}.js written,<br/>codeByNode[target] = the JS"]
    JOIN -->|"returned to readEntity,<br/>real code only"| PARAM["node parameters.jsCode"]
    MOD -->|"real code only"| PARAM
    BOUT -->|"readEntity:<br/>codeByNode[nodeId] wins"| PARAM
```

- `codeByNode` reaches `readEntity` only through `desiredBundleChecksum` and `applyFromState`, and only
  exploded workflows apply it. `planAgainstServer` builds workflow docs without it, and the
  `buildSources` result inside `computePlan` is unused, so the workflow diff does not see a change that
  lives only in a `src/{unit}`.
- "Real code" means something other than comments and whitespace remains.

**Source:** `src/engine/build.ts` (`buildSources`), `src/build/inline.ts` (`inlineUnit`, `parseImports`, `resolveDep`, `transformHelper`, `transformEntry`), `src/layout.ts` (`readEntity` code.ts branch, `hasRealCode`), `src/engine/state.ts` (`computePlan`, `desiredBundleChecksum`), `src/engine/apply-state.ts` (`applyFromState`), `src/engine/plan.ts` (`planAgainstServer`).

## 12. Prompts

Two DB-only kinds that never reach n8n through the API. `prompts` are extracted from LLM nodes and
versioned on any backend. `promptContents` is a runtime registry that an n8n node reads straight from
Mongo, so it exists only on the mongodb backend.

```mermaid
flowchart TD
    subgraph BT["prompts: build-time, DB only, every backend"]
        WF[("n8n workflows")] -->|"pull: pullPromptsFromNodes,<br/>archived workflows skipped"| EX["extractWorkflowPrompts,<br/>enabled nodes only<br/>agent: options.systemMessage<br/>as system, text as user<br/>chainLlm: messageValues by role,<br/>text as user"]
        EX --> PID["localId reused by provenance:<br/>workflow, node, type, index<br/>(seeded from every version<br/>+ live), else a new UUID"]
        PID --> PLIVE[("prompts live docs<br/>content, type, source")]
        PLIVE -->|"pull export:<br/>writeEntity"| PFILE["n8c/prompts/{localId}/<br/>metadata.json + apply.ts"]
        PFILE -->|"plan: buildDocs vs<br/>getLive checksums"| PACT["create, update or noop<br/>live doc without a file:<br/>orphan, or with<br/>--destroy a delete"]
        PACT -->|"apply: no n8n call,<br/>upsertLive or putLive"| PLIVE
        PFILE --> VK["validateAll: prompt keys<br/>unique across prompts/<br/>folders and node<br/>prompt.ts files"]
        NPT["nodes/{nodeId}/prompt.ts<br/>(exploded workflow)"] -->|"readEntity<br/>collects it"| VK
    end
    subgraph RT["promptContents: runtime, mongodb only"]
        CAP["store.capabilities.promptContents<br/>(false on sqlite)"] -->|"ctx.promptContentsEnabled"| SKIPK["plan, apply, pull, list,<br/>restore and drop skip<br/>the kind when false"]
        CFILE["n8c/prompt-contents/{localId}/<br/>apply.ts"] -->|"plan: buildDocs vs getLive<br/>apply: upsertLive"| FLAT["liveStorageDoc spreads<br/>the body to the top level:<br/>key, content or blocks"]
        FLAT --> CCOL[("n8c_prompt_contents<br/>(renameable)")]
        CCOL -->|"pull: getLive rebuilds<br/>the body, putLive,<br/>export: writeEntity"| CFILE
        CCOL -.->|"read at execution time,<br/>outside n8c"| LP["n8n load_prompts node"]
    end
    VK ~~~ CAP
```

- Nothing writes prompt docs back into workflow nodes: a prompt file is versioned and diffed on its own.
- A node's `prompt.ts` is only validated. `workflow.collectExtra`, which would store it as a live prompt,
  is called only from `applyEntity` in `src/engine/apply.ts`, and no command calls `applyEntity`.

**Source:** `src/engine/pull-prompts.ts` (`pullPromptsFromNodes`), `src/engine/extract-prompts.ts` (`extractWorkflowPrompts`), `src/engine/state.ts` (DB-live diff in `computePlan`, `activeKinds`), `src/engine/apply-state.ts`, `src/engine/validate.ts`, `src/layout.ts` (`readEntity` prompt.ts branch, `writeEntity`), `src/entities/prompt.ts`, `src/entities/prompt-content.ts`, `src/entities/workflow.ts` (`collectExtra`), `src/store/live-doc.ts` (`liveStorageDoc`), `src/store/mongo.ts` (`getLive`, `putLive`, `upsertLive`), `src/context.ts`, `src/cli.ts` (pull groups, `readGenerations`).

## 13. Pull and export

`n8c pull` makes the DB and the files mirror n8n: fetch every kind, commit one generation if anything
changed, then rewrite the files.

```mermaid
flowchart TD
    START["n8c pull"] --> Q1{"exporting, no -y, and the<br/>n8c root already holds<br/>entity folders?"}
    Q1 -->|"no"| W
    Q1 -->|"yes, stdin<br/>is not a TTY"| E1["error: re-run with -y"]
    Q1 -->|"yes, TTY"| ASK{"Continue? y/N"}
    ASK -->|"anything but<br/>y or yes"| ABORT["pull aborted,<br/>nothing changed"]
    ASK -->|"y or yes"| W
    subgraph P1["Phase 1: fetch every kind, no version written yet"]
        W["workflows: pullEntity<br/>workflow.pullFromServer<br/>(listWorkflows)<br/>putDefinitions + putLive"]
        PR["prompts: pullPromptsFromNodes<br/>putLive (diagram 12)"]
        PC["prompt-contents, mongodb only:<br/>pullEntity, no server:<br/>getLive, then putLive"]
        CR["credentials: pullEntity<br/>credential.pullFromServer<br/>(listCredentials)<br/>putDefinitions + putLive"]
        W --> PR --> PC --> CR
    end
    CR --> MAP["mapCredentialsFromWorkflows<br/>listWorkflows, node credential<br/>refs merged into the<br/>credential definitions<br/>(merge drops stored updatedAt)"]
    MAP --> CHG{"Phase 2: a kind's checksum<br/>differs from its<br/>active-generation member?"}
    CHG -->|"yes"| GEN["commitPullGeneration<br/>(nextVersionId):<br/>createSnapshot + markActive<br/>for every non-empty kind"]
    CHG -->|"no"| SAME["nothing changed,<br/>no new generation"]
    GEN --> EXP{"Phase 3:<br/>--no-export?"}
    SAME --> EXP
    EXP -->|"yes"| DBONLY["done, DB only"]
    EXP -->|"no"| TYPES["writeTypesFile:<br/>n8c/n8c.types.ts,<br/>tsconfig.json when missing<br/>(a failure is reported,<br/>pull goes on)"]
    TYPES --> EACH["exportDocs for each kind<br/>that has docs (a failure is<br/>reported, other kinds go on)"]
    EACH --> PRUNE["remove entity folders<br/>whose localId is not<br/>in the pulled set"]
    PRUNE --> KIND{"kind"}
    KIND -->|"workflows"| WFX["relink node credential ids<br/>to localIds (unmapped:<br/>export fails),<br/>scanWorkflowSecrets warnings,<br/>metadata.json + apply.ts<br/>(materializeWorkflowSource)<br/>+ environment.json"]
    KIND -->|"credentials"| CFX["metadata.json + apply.ts<br/>with name, type and a<br/>commented data hint"]
    KIND -->|"prompts,<br/>prompt-contents"| PFX["writeEntity:<br/>metadata.json + apply.ts"]
```

- A kind whose pulled set is empty is not exported, so its old folders are not pruned.
- Prompt-contents is skipped on sqlite (diagram 12).

**Source:** `src/cli.ts` (pull handler, `dirHasEntities`, `writeTypesFile`, `printSecretWarnings`), `src/engine/pull.ts` (`pullEntity`, `commitPullGeneration`), `src/engine/pull-prompts.ts`, `src/engine/environment.ts` (`mapCredentialsFromWorkflows`), `src/engine/transfer.ts` (`exportDocs`, `credentialSource`), `src/engine/materialize.ts` (`materializeWorkflowSource`), `src/engine/secret-scan.ts` (`scanWorkflowSecrets`), `src/layout.ts` (`writeEntity`), `src/engine/types-gen.ts`.

## 14. CLI commands and context

How a command line becomes a call: global flags, the per-command handler, and the context most handlers
build first.

```mermaid
flowchart TB
    ENTRY["cli.ts entry point<br/>strips --pipe and --debug<br/>from argv, no command: help,<br/>errors: message + exit 1"] --> PROG["buildProgram<br/>(commander)"]
    PROG --> HOOK["preAction hook<br/>setStyle: TTY, no --pipe,<br/>no NO_COLOR<br/>setDebug: --debug"]
    HOOK --> CMD{"command"}
    CMD --> LOOP["plan, apply, list,<br/>pull, restore, drop<br/>(diagrams 1 to 13)"]
    CMD --> TY["types: writeTypesFile,<br/>credential types from live<br/>docs + listCredentials,<br/>getCredentialSchema per type,<br/>jsonSchemaToTs,<br/>renderTypesFile,<br/>renderTsconfig"]
    CMD --> BK["db export, db import:<br/>store.backupDb, then<br/>dumpBackup or restoreBackup<br/>(mongodb only,<br/>other stores throw)"]
    CMD --> INIT["init"]
    CMD --> CE["create: createEntity<br/>scaffolds a folder<br/>(no store, no n8n)"]
    CMD --> MCP["mcp: startMcpServer<br/>cliPath = argv[1]<br/>(diagram 10)"]
    INIT -->|"unless --db-only"| IP["initProject: n8c.config.json,<br/>.env.example, .env, .gitignore,<br/>only what is missing"]
    IP -->|"--agents"| AG["renderAgentSection +<br/>upsertAgentsMd: AGENTS.md<br/>section between n8c markers"]
    INIT -->|"unless --project-only"| IDB["config + loadEnv,<br/>createStore, initDb:<br/>store.init (mongodb without<br/>MONGO_URI: skipped)"]
    LOOP -->|"handler calls<br/>buildContext first"| CFG
    TY -->|"handler calls<br/>buildContext first"| CFG
    BK -->|"handler calls<br/>buildContext first"| CFG
    subgraph CTX["buildContext(cwd, kind, --env)"]
        CFG["read n8c.config.json<br/>env = --env, else defaultEnv,<br/>else default"] --> ENV["loadEnv: .env or .env.{env}<br/>copied into process.env,<br/>the shell wins"]
        ENV --> CS["createStore: sqlite (default)<br/>or mongodb (diagram 6)"]
        CFG --> VER["resolveN8nVersion(n8nVersion):<br/>runs unconditionally, even for<br/>DB-only commands"]
        CS --> NC["createN8nClient(version, N8N_BASE,<br/>N8N_API_KEY, n8nProjectId),<br/>only when N8N_BASE is set<br/>(diagram 15)"]
        VER --> NC
        NC --> EC["ctx: env, encrypted,<br/>encryptionKey, n8n,<br/>getDefinitions,<br/>promptContentsEnabled"]
    end
    NC -->|"each request"| DBG["debugRequest + debugResponse<br/>printed only with --debug,<br/>request bodies redacted,<br/>only error response bodies printed raw,<br/>success: status only"]
```

**Source:** `src/cli.ts` (`buildProgram`, `isEntryPoint`, `writeTypesFile`, init / types / db / create / mcp handlers), `src/context.ts` (`buildContext`), `src/env.ts` (`loadEnv`), `src/store/factory.ts` (`createStore`), `src/engine/init.ts` (`initProject`, `initDb`), `src/engine/agent-context.ts` (`renderAgentSection`, `upsertAgentsMd`), `src/engine/types-gen.ts` (`fetchCredentialTypes`, `jsonSchemaToTs`, `renderTypesFile`, `renderTsconfig`), `src/engine/backup.ts` (`dumpBackup`, `restoreBackup`), `src/engine/generate.ts` (`createEntity`), `src/style.ts`, `src/debug.ts` (`redact`, `debugRequest`, `debugResponse`), `src/n8n/index.ts` (`resolveN8nVersion`, `createN8nClient`), `src/n8n/base.ts` (constructor, `req`).

## 15. n8n API clients (2.x / 3.x)

n8c talks to n8n 2.x and 3.x only. `n8nVersion` in `n8c.config.json` picks the client class; the engine never
branches on version, it calls the same method names on either.

```mermaid
flowchart TD
    CFGV["n8c.config.json n8nVersion<br/>absent or null: 3"] --> RES["resolveN8nVersion"]
    RES -->|"2 or 3 as a string or a number"| OKV["version 2 or 3"]
    RES -->|"anything else, e.g. 1"| ERR(["throws: unsupported n8nVersion,<br/>n8c supports n8n 2 and 3"])
    OKV --> CRE["createN8nClient(version, baseUrl,<br/>apiKey, fetch, projectId)"]
    CRE -->|"version 2"| V2["N8nClientV2"]
    CRE -->|"version 3"| V3["N8nClientV3"]
    V3 -->|"extends"| V2
    V2 -->|"extends"| BASE["N8nClientBase:<br/>req (error.status, bodies per diagram 14,<br/>a 204 reply resolves to undefined),<br/>reqAll cursor pagination,<br/>listWorkflows, updateWorkflow,<br/>transferWorkflow, deleteWorkflow,<br/>archiveWorkflow, credential methods"]
    V2 --> CW2["createWorkflow: POST /workflows,<br/>body unchanged, then, when<br/>n8nProjectId is set and n8n<br/>returned an id: transferWorkflow,<br/>PUT /workflows/{id}/transfer"]
    V2 --> AW2["activateWorkflow: POST activate<br/>deactivateWorkflow: POST deactivate"]
    V3 --> CW3["createWorkflow, overridden:<br/>POST /workflows with projectId<br/>in the body when n8nProjectId<br/>is set, no transfer call"]
    V3 --> AW3["activateWorkflow: POST publish<br/>deactivateWorkflow: POST unpublish<br/>(both overridden)"]
    V2 --> LW["listWorkflows, V3 inherits it:<br/>when a row has activeVersionId,<br/>active = activeVersionId is not null"]
    V2 --> UW["updateWorkflow, V3 inherits it:<br/>PUT via base"]
    UW --> R{"response"}
    R -->|"ok"| DONE(["updated"])
    R -->|"403 whose body names<br/>workflow:activate or<br/>workflow:publish"| DRAFT(["throws: n8n saved the new version<br/>as a DRAFT, with the recovery steps,<br/>status 403, cause = the original error"])
    R -->|"any other 403,<br/>any other error"| RETH(["rethrows the same<br/>error object"])
```

- `/publish`, `/unpublish` and `projectId` on create only arrived during 2.x (publish and unpublish in 2.33), so
  `N8nClientV2` activates, deactivates and assigns a project through `/activate`, `/deactivate` and `/transfer`,
  which all of 2.x serves. `N8nClientV3` overrides `createWorkflow`, `activateWorkflow` and `deactivateWorkflow`
  for n8n 3.x; the endpoints it uses also exist from 2.33.
- n8n answers the transfer with 204 and no body, so `req` returns `undefined` for a 204 instead of parsing it.
- A PUT on a published workflow makes n8n re-publish it. When n8n refuses that publish with a 403 whose body names
  `workflow:activate` or `workflow:publish`, it still keeps the new version as a draft, so the error says that and
  how to recover: grant the permission and re-run `n8c apply` on the same saved plan (a fresh `n8c plan` compares
  against the saved draft and shows no change), or set `active: false` in the workflow's file. Any other 403 (for
  example a key without `workflow:update`, where nothing was saved) passes through unchanged.
- `listWorkflows` leaves a row untouched when it carries no `activeVersionId` field.

**Source:** `src/n8n/index.ts` (`resolveN8nVersion`, `createN8nClient`), `src/n8n/base.ts` (`N8nClientBase`: `req`, `transferWorkflow`), `src/n8n/v2.ts` (`N8nClientV2`), `src/n8n/v3.ts` (`N8nClientV3`), `src/context.ts` (`buildContext`), `src/engine/init.ts` (`DEFAULT_CONFIG`).

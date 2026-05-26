# Jarvis Workflow Automation

A contributor-facing guide to the workflow system: what it is, how it runs, and where every moving part lives. Read this before touching anything under `src/workflows/`.

> **Heads up:** this system was rewritten from scratch on the `feat/workflows` branch. The old in-process executor, the 50-node hand-rolled registry, and `src/vault/workflows.ts` are gone. The runtime now sits on a vendored copy of the [Activepieces](https://github.com/activepieces/activepieces) engine spawned as a sandboxed child process. If you find a doc or comment that still describes "topo sort + self-heal + NLBuilder", it's stale; refer to this file.

## Reading order

A new contributor should read these, in order:

1. This file -- the architecture overview and the source-tree map.
2. [`PIECE_VERIFICATION.md`](./PIECE_VERIFICATION.md) -- the end-to-end "is my piece wired correctly" checklist. Required reading before adding or editing any piece.
3. [`src/workflows/activepieces/UPSTREAM.md`](../src/workflows/activepieces/UPSTREAM.md) -- which upstream commit we vendor, the license posture, and what we deliberately exclude.
4. [`src/workflows/pieces-library/README.md`](../src/workflows/pieces-library/README.md) -- how community pieces are curated, signed off, and installed at runtime.

## What this is

The workflow runtime lets a user describe an automation (in natural language or visually), persist it as a versioned flow, and execute it on a schedule, on a webhook, or on demand. Every flow is a tree of steps. Every step is either an action or a trigger from a piece. A piece is a self-contained npm package that ships an action's `run()` function and the JSON-schema for its inputs.

The runtime guarantees:

- Steps run inside an engine subprocess, never in the daemon's main loop.
- Step output is checkpointed; a paused flow survives daemon restarts via a zstd execution-state backup.
- Connection secrets are encrypted at rest with AES-256-GCM.
- Every piece's metadata (props, output sample, auth shape) is extracted directly from its compiled bundle, not from a hand-maintained registry.

What it deliberately is NOT:

- Not multi-tenant. One daemon, one user. No projects table beyond a hardcoded `default-project` row.
- Not distributed. The job queue is SQLite-backed; the worker concurrency is 1 by default.
- Not a marketplace. The set of installable pieces is the curated catalog under `src/workflows/pieces-library/` plus the Jarvis-authored pieces in the vendored tree. Users cannot side-load arbitrary npm packages.

## Architecture

```
+------------------------------------------------------------------------------+
|                       Jarvis daemon (Bun, single process)                    |
|                                                                              |
|  Existing services (Agent, Vault, Observers, Channels, ...)                  |
|        |                                                                     |
|        v                                                                     |
|  src/workflows/                                                              |
|    runtime/                                                                  |
|      engine-bootstrap.ts: build engine + compile pieces + start SandboxApi   |
|      service-backends.ts: glues daemon services into /v1/jarvis/* fns        |
|      event-bus.ts + event-buffer.ts: in-process pub/sub for jarvis-trigger   |
|      piece-catalog.ts: engine-extracted catalog + on-disk cache              |
|                                                                              |
|    sandbox-api/   loopback HTTP+WS server (random port, 127.0.0.1)           |
|      socket.io /worker/ws + /v1/* HTTP routes                                |
|        - /v1/worker/{project,app-connections}                                |
|        - /v1/store-entries, /v1/step-files, /v1/waitpoints                   |
|        - /v1/engine/populated-flows, /v1/logs/:runId                         |
|        - /v1/jarvis/{llm,tools,notify,context,agent,events,workflows}        |
|                                                                              |
|    runner/                                                                   |
|      handler.ts: RUN_FLOW JobHandler                                         |
|      engine-runtime/                                                         |
|        engine-runtime.ts: spawn + warm pool (idle TTL 5min)                  |
|        engine-flow-executor.ts: FlowExecutor over EngineHandle               |
|        flow-version-adapter.ts: Jarvis flow shape -> upstream shape          |
|        operation-builder.ts: BEGIN / RESUME / EXTRACT_PIECE_METADATA /       |
|                              EXECUTE_TRIGGER_HOOK                            |
|      triggers/                                                               |
|        manager.ts: cron + webhook + ON_ENABLE/ON_DISABLE routing             |
|        cron.ts: 5-field cron + sub-minute `@every Ns` extension              |
|        webhook.ts: registers `/api/webhooks/<flowId>`                        |
|                                                                              |
|    queue/      SQLite-backed job queue + worker dispatcher                   |
|    db/         schemas + repos (flow, version, run, connection, store,      |
|                waitpoint, workflow_file, job) + AES-256-GCM at-rest enc      |
|    api/        /api/workflows/* HTTP routes                                  |
|    activepieces/  vendored upstream subset (engine, pieces/framework,        |
|                   pieces/common, pieces/jarvis/*)                            |
|    pieces-library/  curated community catalog + installer + reconciler       |
|    credentials/  JarvisConnectionSource adapters (jarvis:google, etc.)       |
|                                                                              |
+------------------------------------------------------------------------------+
                              |
                  spawn child Bun process (engine bundle)
                              v
+------------------------------------------------------------------------------+
| Engine subprocess (one warm process; idle TTL evicts after 5min)             |
|  AP_EXECUTION_MODE=SANDBOX_PROCESS                                           |
|  AP_SANDBOX_WS_PORT=...        SANDBOX_ID=...                                |
|  -> connects to daemon's SandboxApi /worker/ws                               |
|  -> imports vendored pieces dynamically (dev-pieces mode for Jarvis pieces,  |
|     node_modules resolution for community pieces)                            |
|  -> calls back to /v1/* for store, connections, step-files, llm, tools, ... |
+------------------------------------------------------------------------------+
```

## Source tree map

```
src/workflows/
  activepieces/                 Vendored Activepieces source. See UPSTREAM.md.
    LICENSE.activepieces        MIT license preserved verbatim.
    UPSTREAM.md                 Pinned commit + license posture + exclusions.
    packages/
      shared/                   Upstream shared types (BranchOperator, etc.)
      pieces/
        framework/              Upstream `createPiece`, `createAction`, `Property`
        common/                 Upstream helpers (http, auth)
        jarvis/                 Our pieces (ask, tool, notify, context, agent,
                                trigger, regex, test, validate)
      server/engine/            Upstream engine source (we build this into a CJS
                                bundle and spawn it as a child process)

  runtime/                      Daemon-side orchestration above the engine
    engine-bootstrap.ts         Daemon startup: build bundle, compile pieces,
                                spin up SandboxApi, build PieceCatalog
    service-backends.ts         Wraps LLMManager / ToolRegistry / ChannelService
                                / etc. into the function shape /v1/jarvis/*
                                routes expect
    piece-catalog.ts            Engine-extracted catalog + on-disk cache at
                                `~/.jarvis/cache/piece-metadata.json`
    piece-input.ts              Sample-input override clone applied before
                                handing inputs to the engine
    event-bus.ts                Pub/sub used by `jarvis-trigger:on_event`
    event-buffer.ts             Recent-event ring buffer surfaced over /v1
    test-fixtures.ts            Catalog snapshot used by composer tests
    test-fixtures-drift.test.ts Drift test: rebuild catalog vs committed fixture

  sandbox-api/                  Loopback HTTP+WS API the engine subprocess hits
    server.ts                   Bootstraps Fastify + socket.io on 127.0.0.1
    config.ts                   Random-port + bearer-token engine token
    engine-token.ts             Token mint + verify (engine -> daemon auth)
    sandbox-registry.ts         Maps sandboxId -> runId/flowId for /v1 routes
    rpc.ts + worker-rpc.ts      WorkerContract bridge (engine -> daemon RPC)
    routes/                     One file per /v1 surface:
      connections.ts            Encrypted app_connection CRUD
      files.ts                  /v1/step-files binary uploads/downloads
      flows.ts                  /v1/engine/populated-flows (resolves a runtime
                                version + execution context for the engine)
      jarvis-agent.ts           /v1/jarvis/agent  -> agent-delegator
      jarvis-context.ts         /v1/jarvis/context -> vault/awareness/commitments
      jarvis-events.ts          /v1/jarvis/events -> event buffer poll
      jarvis-llm.ts             /v1/jarvis/llm    -> LLMManager.chat
      jarvis-notify.ts          /v1/jarvis/notify -> ChannelService + desktop
      jarvis-tools.ts           /v1/jarvis/tools  -> ToolRegistry.invoke
      jarvis-workflows.ts       /v1/jarvis/workflows -> workflow runner
      logs.ts                   /v1/logs/:runId zstd execution-state backup
      store.ts                  /v1/store-entries (engine's KV store)
      waitpoints.ts             /v1/waitpoints + /api/webhooks/waitpoints/:id

  runner/                       Things that run a flow
    handler.ts                  RUN_FLOW JobHandler -- the worker's entry point
    engine-runtime/
      build.ts                  Builds the engine into a CJS bundle. The bundle
                                is content-addressed; cache lives in
                                `~/.jarvis/cache/engine/<hash>/`
      build-pieces.ts           Walks packages/pieces/jarvis/* and esbuilds each
                                into `~/.jarvis/cache/pieces/<hash>/<short>/`.
                                Content-hash skip on rebuild.
      engine-runtime.ts         Spawns + warms the engine subprocess; manages
                                the single-slot pool with 5min idle TTL
      engine-flow-executor.ts   Implements FlowExecutor by routing every step
                                through EngineHandle.executeFlow
      flow-version-adapter.ts   Maps our FlowVersion DB row -> upstream's shape
      operation-builder.ts      BEGIN / RESUME / EXTRACT_PIECE_METADATA /
                                EXECUTE_TRIGGER_HOOK / EXECUTE_PROPERTY
      execution-state-loader.ts Rehydrates RESUME state from the zstd backup
      code-materialize.ts       CODE pieces materialize source onto disk for
                                the engine to require()
      spawn.ts                  Low-level child_process spawn helpers
    triggers/
      manager.ts                Coordinator: enable/disable a flow's triggers,
                                routes to cron / webhook / engine
      cron.ts                   5-field cron + `@every 10s` sub-minute parser
      webhook.ts                `/api/webhooks/<flowId>` registry

  queue/                        SQLite-backed job queue
    worker.ts                   WorkflowWorker: drains jobs, calls handler.ts
    queue.test.ts               Drain semantics + race-tolerant terminal-status

  db/                           Persistence
    schema.ts                   All SQLite tables (flow, flow_version,
                                flow_run, app_connection, store_entry,
                                waitpoint, workflow_file, workflow_job)
    encryption.ts               AES-256-GCM at-rest for app_connection.value
    repos/                      One file per table; thin CRUD over kysely

  api/                          HTTP routes mounted under /api/workflows/*
    routes.ts                   Route table + handlers (see "API surface" below)

  pieces-library/               Curated community-pieces catalog + installer
    catalog.ts                  Tiered registry (Verified / Community)
    catalog-generated.ts        Auto-synced from npm (do not edit)
    catalog-overrides.ts        Hand-maintained verified set + pins
    installer.ts                Writes ~/.jarvis/pieces/installed.json, runs
                                bun install, extracts metadata
    reconciler.ts               Idempotent reconcile (install/uninstall delta)

  credentials/                  JarvisConnectionSource adapters that bridge
                                Jarvis's existing OAuth/state into pieces
    adapter.ts                  Registry of sources by `jarvis:*` external id
    google-source.ts            jarvis:google -> existing Google OAuth tokens
    telegram-source.ts          jarvis:telegram -> daemon's bot token

  jarvis-pieces/                Daemon-side service shims invoked by /v1/jarvis
    agent-delegator.ts          Backs jarvis-agent.delegate (M7 sub-agent loop)
    context-provider.ts         Backs jarvis-context (vault/awareness reads)
    llm-client.ts               Backs jarvis-ask via LLMManager.chat
    notifier.ts                 Backs jarvis-notify -- per-channel routing
    tool-registry.ts            Backs jarvis-tool -- invoke a Jarvis tool
    workflow-runner.ts          Backs jarvis-trigger.run_workflow

ui/src/v2/rooms/workflows/      The visual editor and runs panel
  WorkflowsRoom.tsx             List view; run history; new workflow
  WorkflowEditor.tsx            xyflow canvas + settings popovers
  useWorkflowEditor.ts          Editor state machine; persistence; auto-layout
  useFlowRuns.ts                Runs panel state + adaptive polling
  useConnections.ts             Connection management
  useLibrary.ts                 Pieces library install/uninstall
  tree.ts                       Tree algebra (insert/delete/wire branches)
  variable-rows.ts              Predecessor-output variable picker source
```

Build scripts and tooling:

```
scripts/
  build-engine.ts               Builds the engine bundle into a content-hashed
                                dir in ~/.jarvis/cache/engine/<hash>/
  build-pieces.ts               Builds every Jarvis-authored piece (content-hash
                                cached)
  build-workflows.ts            Umbrella: bundle + pieces
  sync-activepieces.ts          Pulls a pinned upstream SHA into the vendored
                                tree and re-applies the PATCH_INSERTIONS layer
  sync-pieces-catalog.ts        Refreshes catalog-generated.ts from npm; run by
                                .github/workflows/sync-pieces-catalog.yml
  audit-piece-outputs.ts        Reports which actions declare outputSample (the
                                shape the variable picker depends on)
  check-no-ee-imports.ts        CI guard: refuses any /ee/ path from the vendor
                                tree
  rotate-encryption-key.ts      Decrypt-old + re-encrypt-new + atomic keychain
                                swap for the workflow encryption key
```

## Bootstrap flow

When the daemon starts, `src/workflows/runtime/engine-bootstrap.ts` runs in parallel with the other services. The sequence:

1. `buildEngineBundle()` checks `~/.jarvis/cache/engine/<hash>/main.js`. If the hash matches current sources, returns immediately. Otherwise rebuilds (~700ms cold) and caches.
2. `buildAllJarvisPieces()` walks `packages/pieces/jarvis/*` and esbuilds each piece into its dist dir. Unchanged pieces skip on hash hit (~2ms each).
3. `SandboxApi.listen()` binds a random port on `127.0.0.1` and starts Fastify + socket.io.
4. `EngineRuntime.acquire()` is left to the worker (lazy spawn on first job). The pool holds one warm engine after release; idle TTL evicts after 5 min.
5. `PieceCatalog.build()` runs `EXTRACT_PIECE_METADATA` for every known piece (Jarvis + installed community). Failures don't block successful entries: partial cache writes persist what extracted. The cache key includes `CATALOG_SCHEMA_VERSION` so daemon-side projection changes invalidate it.
6. The bootstrap returns an `{ engineRuntime, pieceCatalog, sandboxApi }` triple that the daemon hands to `WorkflowWorker`, `TriggerManager`, and the API routes.

If bootstrap fails (e.g. esbuild error in a piece), the daemon logs a warning and falls back to "no workflows" mode -- the rest of Jarvis comes up clean. The Workflows room shows an empty-catalog notice.

## Runtime walkthrough -- one flow run

Following a single run from a user click to a SUCCEEDED row:

1. User clicks **Run** in the editor. UI calls `POST /api/workflows/:id/run`.
2. `flowRunRepo.create()` writes a `flow_run` row in PENDING state; `jobQueueRepo.enqueue()` adds a `RUN_FLOW` job.
3. The worker drains the job. `RUN_FLOW` resolves the flow version, materializes any CODE pieces onto disk, then calls `EngineFlowExecutor.executeFlow()`.
4. `EngineRuntime.acquire()` either picks up the warm engine or spawns a fresh one. Spawn passes `AP_SANDBOX_WS_PORT` + an engine token in env.
5. The engine subprocess imports the populated flow's pieces (Jarvis pieces via dev-pieces resolution, community pieces via `node_modules`), runs the trigger payload through each step, and streams `WorkerNotify.updateStepProgress` events back over the WS for every step boundary.
6. The UI's runs panel polls `/api/workflows/:id/runs` adaptively (faster while a run is RUNNING). The overlay on the canvas reflects the latest step status.
7. On terminal status, the engine sends `WorkerContract.updateRunProgress(SUCCEEDED|FAILED|PAUSED)` plus `uploadRunLog` (zstd execution-state). The handler updates the row and releases the engine back to the pool.

If a step calls `context.run.pause()` (e.g. waiting on a webhook), the engine sends PAUSED + the zstd backup. The daemon writes a `waitpoint` row and the run hangs. A later `POST /api/webhooks/waitpoints/:id` enqueues a `RESUME` job; the worker loads the backup, restores execution state via `execution-state-loader.ts`, and the engine picks up exactly where it paused.

## Pieces

Two flavors:

- **Jarvis-authored** pieces live in `src/workflows/activepieces/packages/pieces/jarvis/`. They use the same `createPiece` / `createAction` API as upstream Activepieces. They're auto-discovered: drop a directory with a valid `package.json` and the next daemon restart finds it, builds it, and surfaces it in the library.
- **Community** pieces ship as npm packages. They install at runtime via the pieces library UI -- the installer writes `~/.jarvis/pieces/installed.json`, runs `bun install`, and asks the engine to extract metadata. They are picked from a curated catalog (Verified or Community tier).

Before adding or editing any piece, walk the checklist in [`PIECE_VERIFICATION.md`](./PIECE_VERIFICATION.md). That doc covers the 8 stages from source shape to test layers.

For the community-pieces curation flow (how a piece reaches the Verified tier, sync action, version pinning), read [`src/workflows/pieces-library/README.md`](../src/workflows/pieces-library/README.md).

## Triggers

`TriggerManager` reconciles which triggers are active for which published flow. Three trigger types:

| Source | How it's wired |
|---|---|
| `schedule` (legacy alias `cron`) | Routed to `CronScheduler`. Supports the standard 5-field cron plus a `@every Ns` sub-minute extension. Job ID is `{flowId}:{triggerName}`. |
| `webhook` | Routed to `WebhookManager`. Registers `/api/webhooks/<flowId>`. GET and POST both fire; pieces that need HMAC verify inside their handler. |
| Engine-managed (anything else) | The piece's trigger logic runs in the engine. `EXECUTE_TRIGGER_HOOK(ON_ENABLE)` returns either `scheduleOptions` (registered with `CronScheduler`) or `listeners` (registered with `WebhookManager`). On disable, `EXECUTE_TRIGGER_HOOK(ON_DISABLE)` runs first; persistent state clears even if the engine call fails. |

Polling triggers (e.g. Gmail's watch) live in this third category: the engine schedules a cron-driven `RUN` of the trigger's polling logic and emits new items.

## API surface

Mounted under `/api/workflows/*`. Source: `src/workflows/api/routes.ts`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/workflows` | List flows |
| POST | `/api/workflows` | Create flow |
| GET | `/api/workflows/:id` | Get flow + latest version |
| PATCH | `/api/workflows/:id` | Rename / publish status |
| DELETE | `/api/workflows/:id` | Delete flow + cascade |
| GET | `/api/workflows/:id/versions` | Version history |
| POST | `/api/workflows/:id/versions` | New draft version |
| GET | `/api/workflows/:id/versions/:vid` | Get version |
| POST | `/api/workflows/:id/versions/:vid/lock` | Publish + register triggers |
| POST | `/api/workflows/:id/versions/:vid/sample-data/:step` | Set per-step sample output |
| POST | `/api/workflows/:id/versions/:vid/sample-input/:step` | Set per-step sample input override |
| POST | `/api/workflows/:id/publish` | Publish latest draft |
| POST | `/api/workflows/:id/run` | Enqueue run; accepts `stepNameToTest` for run-from-here |
| GET | `/api/workflows/:id/runs` | Run history |
| GET | `/api/workflows/pieces` | Engine-extracted catalog |
| GET | `/api/workflows/pieces/library` | Catalog of installable community pieces |
| POST | `/api/workflows/pieces/library/:id/install` | Install or update a community piece |
| DELETE | `/api/workflows/pieces/library/:id` | Uninstall a community piece |
| GET | `/api/workflows/connections` | List connections (no secrets) |
| POST | `/api/workflows/connections` | Create / update connection (encrypted) |
| DELETE | `/api/workflows/connections/:id` | Delete + revoke |
| GET | `/api/workflows/triggers` | Active trigger registrations |
| GET | `/api/workflows/events/buffer-stats` | Event buffer health (dropped count, capacity) |
| ANY | `/api/webhooks/:flowId` | Engine-managed webhook trigger fan-in |
| POST | `/api/webhooks/waitpoints/:id` | Resume a paused flow (idempotent: 410 on second hit) |

The engine subprocess hits `/v1/*` on the same daemon (the SandboxApi). Those routes are documented in the `sandbox-api/routes/` files; users never call them.

## NL composer and `manage_workflow`

The primary agent has a `manage_workflow` tool registered (`src/actions/tools/manage-workflow.ts`). It exposes:

- `list`, `get`, `delete`, `enable`, `disable`, `publish` -- straight CRUD over flows.
- `run` -- resolve a flow by name or id and enqueue a `RUN_FLOW`.
- `create` -- create an empty draft (requires `empty: true` or reroutes to compose if `description` is set).
- `compose` -- iterative sub-agent loop. Drives a planner LLM to produce a `FlowVersion` body, validates it against the engine-extracted piece schemas, retries up to 4 times with feedback prompts if validation fails. Reads each action's `outputSample` so the LLM can wire concrete field names.

Source: `src/actions/tools/manage-workflow.ts` and `src/actions/tools/workflow-composer.ts`. The composer's role profile lives in `roles/specialists/workflow-default.yaml`.

## Visual editor (UI)

Lives in `ui/src/v2/rooms/workflows/`. Built on `@xyflow/react`.

Notable behaviors a contributor should know:

- The canvas is horizontal (root on the left, downstream to the right).
- Editor state is owned by `useWorkflowEditor.ts`; tree algebra (insert/delete/wire branches) is a pure module at `tree.ts` with its own test file.
- LOOP body and ROUTER branches render as indented sub-graphs on the canvas. The tree-aware auto-layout distributes router branches symmetrically around the parent.
- Inputs accept `{{step.field}}` templates and render them as chips inline.
- The variable picker opens on input focus and lists predecessor outputs (drawn from `outputSample`). Drag-to-insert or click-to-insert; the chip is placed at the caret.
- Per-step sample input override is stored in `flow_version_ui_meta.sample_input` and applied by `piece-input.ts` before sending inputs to the engine. Used by the "test this step" affordance.
- Right-click on a node opens delete + error-handling options. Right-click on the canvas opens add-piece. Background tap dismisses popovers.
- Connection picker auto-fills the first available connection for the piece's auth type.
- The runs panel polls adaptively (250ms while a run is RUNNING, 5s when idle).

## Persistence and encryption

All workflow tables live in `~/.jarvis/jarvis.db` (the same SQLite file as the rest of Jarvis). Schema: `src/workflows/db/schema.ts`. Repos: `src/workflows/db/repos/`.

Connection secrets are encrypted at rest with AES-256-GCM. Wrapping format: `enc1:<iv>:<tag>:<ciphertext>`. The key comes from `JARVIS_WORKFLOW_ENCRYPTION_KEY` (env) or `~/.jarvis/cache/workflow-encryption.key` (auto-generated, `chmod 0600`). Legacy plaintext rows are accepted transparently for backwards compat.

To rotate the key, run `scripts/rotate-encryption-key.ts`. It decrypts every row with the old key, re-encrypts with the new key, and atomically swaps the keychain. It refuses to run while the daemon is up (checks the daemon lock file).

Run state is checkpointed via zstd. When a flow pauses, the engine sends `uploadRunLog(<zstd-state>)`; on resume, `execution-state-loader.ts` decompresses and hands it back via the BEGIN operation as `RESUME` state. This is why a paused workflow survives a daemon restart cleanly.

## Build, cache, and sync

The whole runtime depends on a content-addressed cache chain. Understanding it is essential for debugging "why isn't my change picked up":

- **Engine bundle hash** mixes the synthesized package.json (esbuild deps), the `UPSTREAM_PIN_SHA`, and every file in `PATCHED_VENDOR_SOURCES` (see `src/workflows/runner/engine-runtime/build.ts`). Editing a patched vendor file flips the hash; a fresh bundle goes to `~/.jarvis/cache/engine/<new-hash>/`.
- **Piece bundle hash** mixes the piece's source tree hash with the engine bundle hash. Framework changes invalidate every piece automatically.
- **Catalog cache key** mixes the bundle hashes of every piece + `CATALOG_SCHEMA_VERSION`. Bump the constant in `piece-catalog.ts` if you change the projection format. Cache lives at `~/.jarvis/cache/piece-metadata.json`.

To re-sync with a newer upstream Activepieces release, edit `UPSTREAM_PIN_TAG` + `UPSTREAM_PIN_SHA` in `src/workflows/activepieces/upstream-pin.ts` and run `bun run scripts/sync-activepieces.ts`. The script pulls the new SHA, re-applies every entry in `PATCH_INSERTIONS`, and fails loudly if any anchor goes missing.

The CI guard `scripts/check-no-ee-imports.ts` runs on pre-commit and on every PR. It refuses any import or vendored path that touches Activepieces' `/ee/` (Enterprise License) tree.

## Testing

Three test layers, run from cheap to expensive:

1. **Unit + integration tests** -- the bulk. Cover repos, queue, tree algebra, composer parser, catalog projection, drift, etc. Run with `bun test src/workflows/`.
2. **Engine-extract tests against real pieces** -- gated. Set `JARVIS_GATED_REAL_PIECE_TESTS=1` to opt in. They actually install a piece (e.g. Gmail) and run `EXTRACT_PIECE_METADATA` against it; useful in CI but pricey locally.
3. **End-to-end engine tests** -- gated by `JARVIS_TEST_ENGINE_BUILD=1`. Build the engine bundle, spawn it, run real flows from BEGIN to terminal status. Includes the RESUME-from-paused suite (`end-to-end-resume.test.ts`) and the Phase L plumbing smoke (`end-to-end-l.test.ts`).

The drift test (`runtime/test-fixtures-drift.test.ts`) compares the live engine-extracted catalog against a committed snapshot. If you change a piece's surface, regenerate the fixture and commit it.

## Common contributor tasks

| Task | Where to start | Cross-links |
|---|---|---|
| Add a new Jarvis piece | Drop a directory under `packages/pieces/jarvis/<name>/` | [`PIECE_VERIFICATION.md`](./PIECE_VERIFICATION.md) |
| Verify a piece works end-to-end | Walk the 8-stage checklist | [`PIECE_VERIFICATION.md`](./PIECE_VERIFICATION.md) |
| Add a community piece to the Verified tier | Edit `catalog-overrides.ts` -> `VERIFIED` | [`pieces-library/README.md`](../src/workflows/pieces-library/README.md) |
| Patch a vendored upstream file | Add an entry to `PATCH_INSERTIONS` in `scripts/sync-activepieces.ts` + register the file in `PATCHED_VENDOR_SOURCES` (so the bundle hash invalidates) | [`UPSTREAM.md`](../src/workflows/activepieces/UPSTREAM.md) |
| Upgrade Activepieces | Edit `UPSTREAM_PIN_*` constants, run `sync-activepieces.ts`, fix any drift the patch layer reports | [`UPSTREAM.md`](../src/workflows/activepieces/UPSTREAM.md) |
| Add a new `/v1/jarvis/*` service | Add a route file under `sandbox-api/routes/`, wire it into `server.ts`, wire the backend into `service-backends.ts` | (this file -- "Source tree map") |
| Bump the catalog projection | Bump `CATALOG_SCHEMA_VERSION` in `piece-catalog.ts` so existing caches invalidate | (this file -- "Build, cache, and sync") |
| Run the engine-extract test against a real piece | `JARVIS_GATED_REAL_PIECE_TESTS=1 bun test src/workflows/runner/engine-runtime/extract-piece-metadata.test.ts` | (this file -- "Testing") |
| Add a new connection source for `jarvis:*` external ids | Implement a `JarvisConnectionSource`, register in `src/workflows/credentials/adapter.ts` | (this file -- "Source tree map") |
| Debug a stuck or weird run | Inspect `flow_run.status` + `waitpoint` rows, then `~/.jarvis/cache/run-logs/<runId>.zst` for the engine's last execution state | (this file -- "Persistence and encryption") |

## Glossary

- **Piece** -- an npm package that ships actions and/or triggers. Examples: `@jarvispieces/piece-jarvis-ask`, `@activepieces/piece-gmail`.
- **Flow** -- a workflow as the user sees it. Has a name, a published state, and many versions.
- **Flow version** -- an immutable snapshot of a flow's tree. Triggers reference a specific version.
- **Flow run** -- one execution of a flow version. Has a status (PENDING / RUNNING / SUCCEEDED / FAILED / PAUSED) and a checkpointed execution state.
- **Connection** -- a stored credential bound to a piece's auth shape. Encrypted at rest.
- **Engine** -- the vendored Activepieces flow executor, built as a CJS bundle and spawned as a child Bun process.
- **Engine subprocess** -- one instance of the engine, running with a unique sandbox id and engine token. Held in a single-slot warm pool with a 5min idle TTL.
- **`outputSample`** -- a literal sample object an action declares to describe its return shape. The variable picker reads from this; the LLM composer reads from this. Required on every action.
- **`PATCHED_VENDOR_SOURCES`** -- the explicit list of vendored upstream files we patch in this fork. Editing any of them must flip the engine bundle hash.
- **`CATALOG_SCHEMA_VERSION`** -- a string mixed into the piece-metadata cache key. Bump it whenever you change the catalog projection format.
- **`SANDBOX_PROCESS`** -- the engine execution mode we use. Child-process IPC, no `isolated-vm`.

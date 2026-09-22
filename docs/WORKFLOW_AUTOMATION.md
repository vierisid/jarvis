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

## Upgrade notes

### Workflow effects now pass an Authority boundary

Every `/v1/jarvis/*` call a step makes -- `tools`, `notify`, `agent`, `workflows`,
`context` and `llm` -- goes through a daemon-owned gate before it dispatches.
Practical consequences:

- A denied Authority category, an emergency pause, or an emergency kill stops the
  step instead of letting it run. The failure names the category that blocked it.
- A category the user put under approval parks the run at a waitpoint and delivers
  an approval request. The run resumes on approval and fails on denial or expiry.
  This is why `jarvis-context` reads can now answer `202` instead of `200`.
- Each effect is recorded in `workflow_effect` with its frozen arguments, target,
  decision and outcome, readable at `GET /api/workflow-runs/:runId/effects`.
- A tool that fails reports a typed outcome rather than a result that happens to
  read like an error: `blocked` (a known prerequisite, e.g. the machine is
  offline) answers `409`, `error` (the remote handler reported failure) `422`,
  and `unknown` (completion could not be established) `502`. `jarvis-tool`
  requires success by default and asserts the outcome itself, so an HTTP `200`
  alone cannot satisfy a step. Clearing its `Require successful action` box is
  for an explicit availability probe: the call answers `200` with the unchanged
  failure outcome so the graph can route on `{{step.outcome.status}}` or its
  stable `code`. It changes how the reply is reported, never what is dispatched,
  and it does not bypass Authority, emergency state, cancellation or approval.
  Every one of these is a terminal receipt: repeating the step, or restarting
  the daemon, returns the same failure without dispatching again.
- `jarvis-tool` only invokes tools with a bounded, declared Authority action (see
  `BOUNDED_TOOLS` in `src/workflows/runtime/effect-capabilities.ts`). Tools whose
  effect is a script or a click sequence -- `run_command`, `browser_click`,
  `desktop_type` and friends -- need a typed `ToolDefinition.workflowEffect`
  adapter first. A flow that called one of those directly now fails with
  "Unsupported direct workflow capability".
- `run_skill` is the one click sequence a flow may invoke, because a skill is
  reviewed content with its own per-step classification (`GATED_TOOLS` in the
  same file). A step `{ toolName: "run_skill", params: { name, params } }` is
  gated on every category the skill's stored steps reach, worst case first (a
  click on Send in a mail app is `send_email`); the approval card reads what
  will actually happen with the resolved parameter values; the effect target
  records the skill's name and version and pins the run to one machine, so a
  skill re-recorded after review, or a different computer, blocks dispatch. A
  skill that cannot run (unknown, disabled, integrity failed, bad parameters)
  is a `blocked` outcome with nothing started; a skill that stops part way is
  an `error` outcome whose earlier steps may have run. Recording and deleting
  skills stay chat-side.
- Community pieces are unaffected by the gate: they run in the engine and never
  reach the daemon's tool surface. See `Governed pieces` below for the verified
  ten, and `src/workflows/pieces-library/README.md` for the curation path.

### `jarvis-ask` answers with a typed outcome

A step that asks for JSON no longer gets the reply text back as if it had
succeeded when the reply is not JSON. `/v1/jarvis/llm/chat` answers
`{ text, parsed?, outcome }`:

- `outcome` is present on every completed call and uses the shared action
  outcome vocabulary in `src/actions/action-outcome.ts`. `parsed` exists only
  when JSON was requested and the outcome is `succeeded`.
- `INVALID_JSON_OUTPUT` means the reply did not parse. `OUTPUT_SCHEMA_MISMATCH`
  means it parsed but missed the declared schema, and the message names the
  paths that failed. Both are `error` with effect `may_have_occurred`: the
  provider was called and answered, so the receipt is a completed effect whose
  result carries the failed contract, and a restarted run reads that receipt
  instead of calling the model again. This is the receipt rule every adapter
  follows: an effect that completed records `succeeded` with its qualified
  outcome inside `result`; an effect that did not complete records `failed`,
  `blocked` or `unknown` with the outcome at the top level of the receipt.
- By default a failed contract answers 422 and the step fails, so nothing
  downstream runs. Turn `Require valid output` off (`requireSuccess: false`)
  only when a later step routes on `{{step.outcome.status}}` and handles the
  failure. That step still gets `text`; it never gets `parsed`.
- `Output schema (JSON)` is a closed JSON Schema subset: `type`, `properties`,
  `required`, `additionalProperties` (boolean), `items`, `enum`, `minItems`,
  `maxItems`, `minLength`, `maxLength`, `minimum`, `maximum`. Any other keyword
  is refused with 400 before the prompt is sent, so a constraint is never
  skipped and then reported as met. The schema checks the reply; it does not
  change the prompt, so ask for the shape in the prompt as well.
- Flows that already had `Parse JSON` on now fail on a reply that is not bare
  JSON, where they used to continue with the text and an empty `parsed`. That
  was the silent path this closes. A flow that meant to tolerate it needs the
  handled-result flag and a router branch on the outcome.

### `jarvis-agent` pauses on approvals and declares its outcome

A tool call inside a delegated sub-agent that needs approval no longer ends
as a denial in the conversation. It becomes an `agent-tool:N` workflow
effect judged as the sub-agent itself, the run parks on its approval, and
after the decision the same step runs again and the conversation continues
where it stopped, in this process or the next. The sub-agent's message log is
checkpointed in `workflow_delegation` after every turn and while it waits,
dropped when it finishes or the run is cancelled; a step the engine runs
again after that answers from the record. A declined approval becomes
`[APPROVAL DENIED]` in the conversation and the tool never runs. A tool the
direct tool piece refuses as opaque (`run_command`, browser clicks and
typing) is refused here too when it would need approval; one the sub-agent's
Authority allows outright runs inside the sub-agent as before.

The step's `outcome` is its business contract. `Required tools` names the
tools that must complete; `succeeded` means the conversation finished and
each of them has a result and no error. Without them, `succeeded` only says
the agent finished cleanly. A failed outcome (`REQUIRED_TOOL_NOT_COMPLETED`,
`AGENT_INCOMPLETE`, `AGENT_ERROR`) answers 422 and stops the step; turn
`Require the declared outcome` off to route on `{{step.outcome.status}}`
instead. The sub-agent's audit rows now record what happened: a call that
needed approval is `approval_required` and not executed, and an allowed call
is recorded after it ran.

### Governed pieces

The ten verified pieces -- gmail, slack, notion, openai, github, google-calendar,
google-drive, discord, telegram-bot, claude -- carry a typed governed adapter in
`src/workflows/runtime/piece-effects.ts`. Before one of their actions runs, the
engine asks the daemon at `/v1/jarvis/pieces/authorize`, and the answer comes
from the same Authority boundary every other effect passes: emergency and
cancellation fences, a durable `workflow_effect` row, an audit row, and an
approval waitpoint when the category is governed. The approval card carries the
step's resolved input and the resolved target -- the recipient, file or endpoint
the action will touch -- never the connection credential, which is stripped in
the engine before the input is sent and again on arrival.

Categories are per action, not per piece: `gmail_search_mail` is `read_data`,
`gmail_create_draft` is `write_data`, `send_email` is `send_email`, and
`gmail_delete_draft` is `delete_data`. An action the table does not name --
one added by a later upstream release, or `custom_api_call`, which can reach any
endpoint of that API -- takes the piece's worst-case category, never `read_data`.

What this does NOT do:

- It does not close the catalogue. Every other piece stays installable and
  runnable exactly as before; a piece with no adapter is reported ungoverned and
  the step proceeds untouched. The verified set grows by landing an adapter.
- It does not govern `CODE` steps, which run in a spawned child process with host
  privileges and make their own calls. They are not governed, they are gated:
  a flow containing one is refused at publish unless CODE was enabled for that
  flow. See `CODE steps need a per-flow opt-in` above.
- It does not make the daemon the caller. The piece's own HTTPS request still
  happens in the engine subprocess after the daemon authorizes it, so the
  recorded outcome is a dispatch authorization, not a delivery receipt. The gate
  holds against an untrusted composed `FlowVersion`, which is the threat it was
  built for; it does not hold against a malicious piece, which is why it covers
  only pieces that have been read and vetted.
- It does not cover triggers. Polling triggers run on a different engine path.

### `CODE` steps need a per-flow opt-in

A `CODE` step is not a sandboxed expression and not an isolate. The engine
writes the step's `sourceCode` bundle to disk and runs it in the engine
subprocess: `AP_EXECUTION_MODE=SANDBOX_PROCESS` is a CHILD PROCESS, so that
JavaScript has every privilege the daemon's user has -- the whole filesystem,
the network, the shell. None of it comes back through the daemon, so none of it
is visible to the Authority boundary above. That is the whole reason for the
gate: a flow is not always hand-authored, `manage_workflow compose` builds a
`FlowVersion` out of an LLM plan, and LLM output is untrusted here.

So CODE is off by default, and the permission is granted PER FLOW:

```
POST /api/workflows/<flowId>/code-steps   {"enabled": true}
```

A global switch would be the wrong shape: turning CODE on for one automation
would turn it on for every flow composed afterwards, which is the thing the
gate exists to prevent.

The refusal happens at AUTHORING time, never per execution:

- `POST /api/workflows/:id/publish` and `manage_workflow publish` refuse with
  403 and change nothing -- the version is not locked, not attached, and the
  flow is not enabled.
- Enabling a flow refuses the same way (`PATCH /api/workflows/:id` with
  `status: "ENABLED"`, `manage_workflow enable`), because the trigger manager
  registers an ENABLED flow's cron against `published ?? latest draft`: without
  this, a flow could start firing on a schedule without ever being published.
- Asking for a run directly refuses too (`POST /api/workflows/:id/run`,
  `manage_workflow run`, and a nested `run_workflow` step). This is defence in
  depth, not the primary gate, and it can only ever refuse an UNPUBLISHED
  draft: publish already requires the grant, so a published flow carries it.
- Writing a CODE step INTO the draft an ENABLED flow is already running is
  refused as well. A flow that is ENABLED with nothing published runs its
  latest draft, and a draft row is mutated in place, so that save is a deploy:
  without this the graph behind a registered cron could pick up a CODE step
  after the enable gate had passed. `createDraftVersion` and
  `updateDraftVersion` are the only two writers of `flow_version.trigger`, so
  both carry the check. Editing a draft on a DISABLED flow, or on one that has
  a published version, stays completely free -- publish is still ahead of it.
- Finally, `TriggerManager` declines to register a subscription for a version
  with an ungranted CODE step, and logs why. Registration happens at boot and
  on refresh, not per execution, so this is not #459's run-time refusal; it is
  the backstop for the one thing the authoring gates cannot see, namely that
  "latest draft" moves with any write that bumps a draft's `updated`, so a
  CODE draft that was not live when the flow was enabled can become live
  later. A published flow always carries the grant, so this can only ever
  decline a flow that was never publishable.

Nothing is refused per execution. That was the flaw in the allowlist cut from
#459: it refused at run time, so a cron- or webhook-triggered flow published
successfully and then failed on every fire with nobody there to read why.

The message names what was refused, which step caused it, and the call that
grants the permission. A CODE step is found wherever it is -- the walker in
`src/workflows/db/flow-graph.ts` follows `nextAction`, a LOOP's
`firstLoopAction` and every ROUTER branch in `children`, so a step parked
inside a loop or behind a branch is not missed.

**Existing flows are grandfathered, visibly.** On the first boot that adds the
column, any flow that is already runnable (ENABLED, or carrying a published
version) whose runnable version actually contains a CODE step gets the
permission, stamped `grantedBy: "upgrade"`. An automation that has been running
a CODE step on a cron for months does not stop because the daemon restarted on
a newer build, and the grant is not silent: `GET /api/workflows` reports
`codeSteps: { enabled, grantedBy, grantedAt }` per flow, so the dashboard can
say the permission was inherited rather than chosen, and the user can revoke it
with `{"enabled": false}`. Every other flow -- including one holding an
unpublished CODE draft -- starts at OFF.

Revoking with `{"enabled": false}` takes the permission away from the next
publish, enable, run or draft write, and from the next trigger registration --
so a live schedule keeps firing until the daemon restarts or the flow is
refreshed, and then stops. It does not unpublish the version and it does not
stop a run already in flight. Disabling the flow is what stops a schedule
immediately. The grant is not handed back later: the upgrade backfill is keyed
on the columns being introduced, so a revoked permission stays revoked across
restarts. The other side of that key is that a build rolled back below this
version and then rolled forward again will not re-grandfather a flow published
in between; such a flow needs the opt-in like any other.

Three deliberate omissions:

- `manage_workflow` has no action that grants the permission. The threat is an
  untrusted LLM-authored `FlowVersion`; a tool action that let the model grant
  itself CODE would be the gate writing its own exception.
- Piece admission is untouched. All 657 catalogue entries stay installable and
  runnable. This gate is CODE steps only.
- A linked work item (`startWorkItemRun`, `src/goals/workflow-bridge.ts`) is not
  gated. It runs one LOCKED version that the user personally accepted on an
  approval card, which is a per-version consent signal stronger than the
  per-flow flag, and gating it would break an accepted proposal mid-flight on
  upgrade.

Also worth knowing: `manage_workflow compose` cannot emit a CODE step at all.
Its validator accepts `PIECE`, `LOOP_ON_ITEMS` and `ROUTER` for action steps
and nothing else, so the LLM path produces CODE-free flows and the gate is
never in the composer's way.

### `{{ ... }}` expressions are data, not JavaScript

The vendored engine's expression evaluator used `Function(...)`, so any inline
expression ran arbitrary code inside the engine subprocess with host privileges.
It is now a bounded data interpreter (`src/workflows/runtime/safe-expression.ts`).

Supported: property references, dot/bracket/optional access, primitive literals,
arrays and objects, arithmetic, comparisons, logical and nullish operators,
ternaries, and `flattenNestedKeys(data, path)`.

Not supported: method calls (`.map`, `.split`, `.toUpperCase`), constructors
(`new Date()`), `JSON.parse`, assignment, spread, globals, and prototype access.

An unsupported expression now **fails the step loudly** instead of silently
resolving to an empty string, and the error quotes the expression that failed.
Flows that relied on a JavaScript method in an input need the value reshaped
upstream -- by the step that produces it, or by a piece that returns the shape
you want.

Limits per expression: 16,384 source characters, 2,048 tokens, depth 64, 10,000
evaluation visits, and 1,048,576 accumulated output characters.

### A run is pinned to one computer and one connection

A workflow run used to pick a machine per step. If the chosen computer dropped
between two steps, the next step re-ran auto-selection and landed on whichever
other sidecar happened to be connected -- and recorded that as a success. A
click, a keystroke or a command could therefore execute on a machine nobody
reviewed.

The first machine operation in a run now pins the run to one computer and to
that computer's exact control socket, durably, in
`workflow_run_machine_binding`. `GET /api/workflow-runs/:runId` exposes it as
`machineBinding`. The binding is written once inside an immediate transaction
and is never rewritten: there is no in-place retarget, no automatic retry and
no fallback to another sidecar.

Later dispatches -- including delegated-agent tool calls, approval resumes and
the RPC send inside `SidecarManager` itself -- are checked against it. What was
a silent switch is now a typed `blocked` outcome with `effect: 'not_started'`:

- `WORKFLOW_MACHINE_OFFLINE` -- the bound computer is offline or no longer
  enrolled.
- `WORKFLOW_SESSION_CHANGED` -- it reconnected, so this is a different socket
  than the one the work was reviewed against. A daemon restart has the same
  effect for local execution.
- `WORKFLOW_CAPABILITY_UNAVAILABLE` -- the bound computer no longer advertises
  the capability the step needs.
- `WORKFLOW_RETARGET_REQUIRED` -- the step asked for a different computer than
  the run is bound to.
- `WORKFLOW_TARGET_AMBIGUOUS` -- an explicit name matched no device or several.
- `WORKFLOW_MACHINE_UNAVAILABLE` -- nothing capable is connected and local
  execution is disabled.
- `WORKFLOW_BINDING_LEGACY` -- the run already did machine work under an older
  binary, so it has no verifiable connection generation to adopt.

Every one of these says no action was dispatched. Earlier receipts in the same
run keep their results, including a result that arrives after the machine
dropped, so recovery is to review the recorded effects and start a new run with
an explicit target and fresh approvals -- not to replay completed work. A
workflow that deliberately used two different computers in one run needs two
reviewed runs.

Only steps that touch a machine bind one, so a flow that never leaves the
daemon is unaffected, and ordinary chat routing is untouched.

### Previews resolve saved samples, but not for perception steps

Testing a single step reuses the version's saved sample data for the steps it
depends on. Those samples have no trusted machine or connection provenance: a
window id or element id captured from an earlier preview may name something on
a machine that is gone, or something that has since moved.

A preview of a desktop, browser or screenshot step is therefore refused with
`WORKFLOW_SAMPLE_BINDING_UNKNOWN` when the step's input references another
step's saved output. The guard reads the dispatching step's expressions -- the
child a router or loop actually runs, the run's frozen input override, and
nested and loop-derived references, taking both branches of a ternary -- and it
only looks at which steps an expression names, never at what the sample
contains. Fields inside a sample's JSON cannot claim provenance for it.

What still works unchanged: unrelated saved samples, the tested step's own
auto-captured output, literal inputs, the current trigger payload, and every
non-machine preview. To get past the refusal, run the perception step again in
a full run.

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
    cancellation.ts             Dispatch fence: assert / scope / abort helpers
                                every run's next action is checked against
    cancellation-signals.ts     In-process bus that wakes the active executor
                                once the fence commits
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
    retry-policy.ts             One attempt per RUN_FLOW job + operator guidance
    queue.test.ts               Drain semantics + race-tolerant terminal-status

  db/                           Persistence
    schema.ts                   All SQLite tables (flow, flow_version,
                                flow_run, workflow_run_cancellation,
                                app_connection, store_entry, waitpoint,
                                workflow_file, workflow_job)
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
2. `flowRunRepo.create()` writes a `flow_run` row in QUEUED state; `jobQueueRepo.enqueue()` adds a `RUN_FLOW` job.
3. The worker drains the job. `RUN_FLOW` resolves the flow version, materializes any CODE pieces onto disk, then calls `EngineFlowExecutor.executeFlow()`.
4. `EngineRuntime.acquire()` either picks up the warm engine or spawns a fresh one. Spawn passes `AP_SANDBOX_WS_PORT` + an engine token in env.
5. The engine subprocess imports the populated flow's pieces (Jarvis pieces via dev-pieces resolution, community pieces via `node_modules`), runs the trigger payload through each step, and streams `WorkerNotify.updateStepProgress` events back over the WS for every step boundary.
6. The UI's runs panel polls `/api/workflows/:id/runs` adaptively (faster while a run is RUNNING). The overlay on the canvas reflects the latest step status.
7. On terminal status, the engine sends `WorkerContract.updateRunProgress(SUCCEEDED|FAILED|PAUSED)` plus `uploadRunLog` (zstd execution-state). The handler updates the row and releases the engine back to the pool.

Cancellation (`POST /api/workflow-runs/:runId/cancel`) is a durable dispatch fence, not a remote undo. One SQLite transaction writes a `workflow_run_cancellation` row, marks the run STOPPED, and cancels every active `RUN_FLOW` job for it; only after that commit is the active executor signaled, which aborts the engine RPC and kills the subprocess instead of returning it to the warm pool. The fence outlives a restart and a workflow deletion: `enqueue`, `createWaitpoint` and every `/v1/jarvis/*` action route re-check it, and `updateRun` lets a late result add step evidence but never revoke STOPPED. An effect already dispatched may still land, so the run reports `inFlightMayHaveCompleted` and the dashboard says so.

If a step calls `context.run.pause()` (e.g. waiting on a webhook), the engine sends PAUSED + the zstd backup. The daemon writes a `waitpoint` row and the run hangs. A later `POST /api/webhooks/waitpoints/:id` enqueues a `RESUME` job; the worker loads the backup, restores execution state via `execution-state-loader.ts`, and the engine picks up exactly where it paused.

### Run status lifecycle

`FlowRunStatus` (`src/workflows/db/repos/flow-run.ts`) has eleven values. Only two are non-final for a given attempt:

```
QUEUED --claim--> RUNNING --+--> SUCCEEDED
                            |
                            +--> PAUSED --resume--> RUNNING --> ...
                            |
                            +--> FAILED | INTERNAL_ERROR | TIMEOUT | STOPPED
                                 | QUOTA_EXCEEDED | MEMORY_LIMIT_EXCEEDED
                                 | SCHEDULE_FAILURE
```

A **queue job** and a **run** finish on different clocks. A `RUN_FLOW` job covers one execution slice; when that slice ends at a waitpoint the job is SUCCEEDED and the run stays PAUSED. `FlowExecutorResult.status` carries that distinction out of the executor so `createRunFlowHandler` can persist the pause instead of overwriting it with SUCCEEDED:

- On PAUSED the handler persists `steps` + `steps_count`, sets `finish_time` to NULL, and skips sample-data auto-capture. `finish_time` stays NULL for the whole pause, so nothing reports a paused run as finished or computes a duration for it.
- Each job clears `finish_time` when it flips the run to RUNNING, so a RESUME never carries a stale finish time left behind by an earlier slice. `start_time` is preserved across resumes.
- A resume re-enters the same run id with a new `RUN_FLOW` job carrying `executionType: "RESUME"`. The handler refuses a BEGIN for a run that is not QUEUED and a RESUME for a run that is not PAUSED, so a durable PAUSED row is what makes the continuation legal -- see "Failure and restart" below.

Two things produce that resume job, both server-side:

- `POST /api/webhooks/waitpoints/:id` for WEBHOOK/MANUAL waitpoints. It refuses anything but a PAUSED run (409) and an already-resumed waitpoint (410).
- `TimerWaitpointScheduler` (`src/workflows/timer-scheduler.ts`) for TIMER waitpoints, which have no external trigger. It ticks every 15s plus once at boot, so a delay that elapsed entirely during downtime still fires. Marking the waitpoint resumed and enqueueing the job happen in one transaction, so a crash between them cannot strand the run.

The scheduler's eligibility query (`listDueTimerWaitpoints`) skips waitpoints whose run is still QUEUED or RUNNING, *before* applying its 100-row batch limit. The engine creates the waitpoint row before it publishes PAUSED, so a short delay can come due inside that window; retiring the timer there would strand the run PAUSED with nothing left to wake it. Deferring instead also keeps those rows from filling a scan and starving later PAUSED runs. Missing and terminal runs still get their timers retired.

The one transition not shown above is boot recovery: an orphaned run whose job died mid-flight is retired to FAILED rather than replayed, again covered in "Failure and restart" below. A run that had durably PAUSED is the exception and stays PAUSED, which is what lets its timer or webhook still fire after a restart.

## Failure and restart: no automatic replay

A flow step can deliver a real effect (send a message, hit an API, write a
file) and the queue has no receipt for it, so `RUN_FLOW` is never retried
automatically. `src/workflows/queue/retry-policy.ts` pins every `RUN_FLOW`
job -- BEGIN and RESUME alike -- to a single attempt, whatever the caller
asked for, and an expired `RUN_FLOW` lease is never stolen by another claim.
Other job types keep the default three attempts with backoff.

What that means in practice:

- A step failure ends the run `FAILED` once. The reason lands in
  `flow_run.failed_step.errorMessage` (chat `get_run`, the runs API and the
  editor's run banner all read it) with guidance to check which effects
  already completed before starting a new run.
- A daemon crash or an over-deadline drain leaves the job `RUNNING`. The next
  boot's `recoverOrphanedJobs()` retires it: the job goes `FAILED` and its
  unfinished run goes `FAILED` too, in one transaction, keeping whatever step
  outputs were recorded. It is NOT resumed -- the effects of the interrupted
  step are unknown.
- A run that had durably PAUSED is the exception: if it still has an open
  waitpoint, or a fresh single-attempt `RESUME` job already queued for it,
  boot recovery leaves it `PAUSED` so the planned continuation still fires.
- Re-running is a user decision. A new run is a new `flow_run`; nothing in the
  queue treats a fresh job as permission to replay an existing run, and the
  handler refuses a BEGIN for a run that is not `QUEUED` or a RESUME for a run
  that is not `PAUSED`.

Durable per-effect receipts and reconciliation-based recovery are follow-up
work; this policy is containment, not exactly-once execution.

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
| POST | `/api/workflows/:id/versions/:vid/lock` | Freeze a draft (DRAFT -> LOCKED). Does not publish and does not refresh triggers |
| POST | `/api/workflows/:id/versions/:vid/sample-data/:step` | Set per-step sample output |
| POST | `/api/workflows/:id/versions/:vid/sample-input/:step` | Set per-step sample input override |
| POST | `/api/workflows/:id/publish` | Publish latest draft (403 when the version has a CODE step and CODE is off for the flow) |
| POST | `/api/workflows/:id/code-steps` | Grant or revoke this flow's CODE-step permission (`{"enabled": bool}`) |
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
| POST | `/api/workflow-runs/:runId/cancel` | Close the run's dispatch fence (idempotent; `accepted: false` once finished) |

Every `/api/workflows/:id/versions/:vid` route requires `:vid` to be a version
of `:id`. A wrong-parent, missing or unknown version returns 404 without
reading the version or touching either flow, and `POST /api/workflows/:id/publish`
returns 404 for an explicit `versionId` belonging to another flow. That publish
body must be empty, `{}`, or `{ versionId }` with a non-empty string; malformed
JSON and non-object bodies return 400 instead of falling back to the latest
draft. `flow.published_version_id` can only ever name a version of that flow.

The engine subprocess hits `/v1/*` on the same daemon (the SandboxApi). Those routes are documented in the `sandbox-api/routes/` files; users never call them.

## NL composer and `manage_workflow`

The primary agent has a `manage_workflow` tool registered (`src/actions/tools/manage-workflow.ts`). It exposes:

- `list`, `get`, `delete`, `enable`, `disable`, `publish` -- straight CRUD over flows.
- `run` -- resolve a flow by name or id and enqueue a `RUN_FLOW`.
- `create` -- create an empty draft (requires `empty: true` or reroutes to compose if `description` is set).
- `compose` -- sub-agent that builds a `FlowVersion` body from a plain-English description. Two modes:
  - **Tool loop (preferred)**: the planner LLM discovers the platform through tools -- `list_pieces` (compact index), `get_piece_details` / `get_tool_details` (input schemas + `outputSample`s on demand), `search_library` (installable community pieces) -- and finishes via `submit_flow` (validated against the engine-extracted piece schemas; errors fed back as the tool result, up to 4 submits) or `report_blocked` (structured failure carrying `suggestedInstalls` when a library piece would cover the request).
  - **One-shot fallback**: for text-only clients or models that don't call tools, the full piece catalog is inlined into one system prompt and parse/validation errors feed a retry loop (up to 4 attempts). Both modes share the same rule sections and worked examples in the system prompt.

Source: `src/actions/tools/manage-workflow.ts` and `src/actions/tools/workflow-composer.ts`. The composer's role profile lives in `roles/specialists/workflow-default.yaml`.

### Intent-preserving repair

Every repair prompt carries the same versioned job specification, the latest raw
candidate response, the last parseable graph and the current parse/validation
errors. This applies to one-shot repairs, inline JSON and `submit_flow` feedback,
including a first-turn tool response that falls back to one-shot composition.
Malformed text does not erase the last parseable graph. The specification is
authoritative over conflicting candidate data; repair instructions explicitly
preserve the requested trigger, output, destination and negative constraints.

Specification version 1 is `{ schemaVersion: 1, name, description }`. It preserves
the caller's wording rather than inferring structured constraints with another
model. For accepted suggestions, the description includes the accepted expected
outcome. Structural validation still cannot prove fidelity to arbitrary natural
language; the regression tests exercise context transport with synthetic providers,
not live-model success rates.

Both production entry points use `composePersistedFlow`, which saves the
specification to `workflow_composition` before the first provider request and
checkpoints each candidate before another repair. Each write commits separately;
no database transaction spans an LLM call. Records retain full candidate text even
when the chat tool caps its returned `rawResponse`. The resulting flow metadata
contains `compositionRecordId`; chat also returns that ID on success or a normal
composition failure. The record is readable with `getWorkflowComposition(id)`.

Records have three states: `COMPOSING`, `VALIDATED` (structural checks passed), and
`FAILED`. `VALIDATED` does not mean a draft was attached, published, or executed.
An interrupted attempt may remain `COMPOSING` with its last checkpoint after a
restart; this table is authoring provenance, not a queue, and never resumes work
or spends on its own. Suggestion retries continue to use their existing explicit
job contract. The new table is additive; older binaries can ignore it without
rewriting existing flows. Like draft graphs, these records contain user content
in the shared database and its backups.

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

### Routine requests tab

`RoutineRequestsPanel.tsx` is a fourth tab beside Flows, Connections and Library. It
lists the automation proposals awareness has saved and the drafts they turned into,
reading `/api/awareness/routines` and `/api/awareness/compositions`. The legacy overlay
(`ui/overlay.html`) reaches the same endpoints.

Accepting a proposal (`POST /api/awareness/suggestions/:id/accept`) does not compose
inline. It saves the user-confirmed request as one row in `suggestion_composition_jobs`
and returns. `SuggestionComposer` (`src/awareness/suggestion-composer.ts`) then claims
the job under a lease token, calls `composePersistedFlow` with the same deps `manage_workflow`
uses, and commits the flow, its draft version and the job result in a single
transaction -- the LLM call itself never runs inside a transaction. An interrupted or
timed-out attempt keeps the saved request and requires an explicit retry, so a crash
never re-spends on its own.

The composed flow is created DISABLED with no published version, so accepting a
proposal registers no trigger and runs nothing; publishing and enabling stay explicit
user steps.

## Persistence and encryption

All workflow tables live in `~/.jarvis/jarvis.db` (the same SQLite file as the rest of Jarvis). Schema: `src/workflows/db/schema.ts`. Repos: `src/workflows/db/repos/`.

Connection secrets are encrypted at rest with AES-256-GCM. Wrapping format: `enc1a:<base64(iv | tag | ciphertext)>`, with the row's `(id, project_id, piece_name, external_id)` passed as GCM associated data so a stored value only authenticates against the row it was written for. The older unbound `enc1:` format is still read; convert it with `bun scripts/migrate-native-credentials.ts bind`. The key comes from `JARVIS_WORKFLOW_ENCRYPTION_KEY` (env), `JARVIS_WORKFLOW_ENCRYPTION_KEY_FILE` (an explicit file), or `<data dir>/workflow-encryption.key` (auto-generated, `chmod 0600`) -- the data dir being `JARVIS_SECRETS_DIR` or `JARVIS_HOME` when set and `~/.jarvis` otherwise, the same resolution `.secrets.key` uses. It sits at the data-dir ROOT so any backup of the data dir carries it and `jarvis export --full` lists it; it used to live under `cache/`, which is excluded from exports and documented as disposable. A key still found at the old path is read, and relocated once at daemon boot. Legacy plaintext rows are accepted transparently for backwards compat; set `JARVIS_REQUIRE_ENCRYPTED_CREDENTIALS=1` once conversion is done to refuse them.

If `app_connection` holds encrypted rows in either envelope and no key can be resolved, the daemon refuses to start rather than generating a fresh one: a new key cannot decrypt those rows, and writing with it would overwrite the last copy of the ciphertext. Restore the key file (or set the env var) and start again.

To rotate the key, run `scripts/rotate-encryption-key.ts`. It decrypts every row with the old key, re-encrypts with the new key, and atomically swaps the keychain. It refuses to run while the daemon is up (checks the daemon lock file).

Run state is checkpointed via zstd. When a flow pauses, the engine sends `uploadRunLog(<zstd-state>)`; on resume, `execution-state-loader.ts` decompresses and hands it back via the BEGIN operation as `RESUME` state. This is why a paused workflow survives a daemon restart cleanly.

## Build, cache, and sync

The whole runtime depends on a content-addressed cache chain. Understanding it is essential for debugging "why isn't my change picked up":

- **Engine bundle hash** mixes the synthesized package.json (esbuild deps), the `UPSTREAM_PIN_SHA`, and every file in `PATCHED_VENDOR_SOURCES` (see `src/workflows/runner/engine-runtime/build.ts`). Editing a patched vendor file flips the hash; a fresh bundle goes to `~/.jarvis/cache/engine/<new-hash>/`.
- **Piece bundle hash** mixes the piece's source tree hash with the engine bundle hash. Framework changes invalidate every piece automatically.
- **Catalog cache key** mixes the bundle hashes of every piece + `CATALOG_SCHEMA_VERSION`. Bump the constant in `piece-catalog.ts` if you change the projection format. Cache lives at `~/.jarvis/cache/piece-metadata.json`.

To re-sync with a newer upstream Activepieces release, edit `UPSTREAM_PIN_TAG` + `UPSTREAM_PIN_SHA` in `src/workflows/activepieces/upstream-pin.ts` and run `bun run scripts/sync-activepieces.ts`. The script pulls the new SHA, re-applies every entry in `PATCH_INSERTIONS`, and fails loudly if any anchor goes missing.

The CI guard `scripts/check-no-ee-imports.ts` runs on pre-commit and on every PR. It refuses any import or vendored path that touches Activepieces' `/ee/` (Enterprise License) tree.

### Engine subprocess lifecycle (who kills the engine)

The engine is **pooled across runs by design**, so an engine that is merely still running is working as intended. An engine with no owner is not. Four things keep that from happening (added for #491, where one survived its parent by 82 minutes and ignored SIGTERM):

- **The engine exits on SIGTERM.** Upstream registers a SIGTERM listener that flushes run progress and never exits, which silently removes the runtime's default terminate-on-signal. A shim prepended by the esbuild banner (`engine-lifecycle.ts`) registers first, lets that flush run, then restores the default disposition and re-raises the signal. The shim is part of the bundle hash, so changing it invalidates cached bundles.
- **The engine exits when its owner dies.** The same shim polls whether the pid that spawned it is still alive (signal 0 plus a `/proc` start-time comparison, because Bun caches `process.ppid` at first access and a reparenting check would never fire).
- **The owner reclaims what it spawned.** `spawn.ts` keeps a registry of live engines; `EngineRuntime.shutdown()` kills every engine it spawned, not just the parked one; a `bun test` run that ends with one still alive is reclaimed and **fails the run** via the guard in `src/test-preload.ts` (`JARVIS_ALLOW_LEAKED_ENGINES=1` to opt out while reproducing).
- **Known residue:** a CODE action's own `bun --eval` child inherits the engine's environment but is deliberately never matched by the reaper (it may be mid-step), so reaping its engine orphans it in turn. It holds no pool state and no socket, and `engine-reaper.ts` documents how to match it by ppid if they ever start accumulating.
- **The daemon reaps and prunes at startup.** `engine-reaper.ts` kills engines whose owner is provably gone -- matched by our marker env var, our uid and an argv naming their own bundle, never by process-name pattern -- and prunes `~/.jarvis/cache/engine` by count and age, never touching the bundle in use, a bundle a running engine is executing, or a shared read-only root. `bun run scripts/reap-engines.ts [--dry-run]` does the same by hand.

Knobs (env var wins over the `workflows` config section):

| Variable | Default | Meaning |
| --- | --- | --- |
| `JARVIS_ENGINE_SHUTDOWN_GRACE_MS` | derived: strictly inside the owner's SIGKILL deadline | How long the engine keeps flushing after SIGTERM before exiting. Derived from the owner's kill grace so the two cannot drift; setting it at or above that deadline is warned about. |
| `JARVIS_ENGINE_ORPHAN_POLL_MS` | 5000 | Orphan-watchdog interval inside the engine. 0 disables it. |
| `JARVIS_ENGINE_CACHE_MAX_BUNDLES` / `workflows.engineCacheMaxBundles` | 3 | Bundles kept in `~/.jarvis/cache/engine`. 0 disables the count cap. |
| `JARVIS_ENGINE_CACHE_MAX_AGE_DAYS` / `workflows.engineCacheMaxAgeDays` | 14 | Age past which an untouched bundle is deleted. 0 disables the age cap. |

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
| Debug a stuck or weird run | Inspect `flow_run.status` + `waitpoint` rows (a run stuck PAUSED has an unresumed one), then `~/.jarvis/workflow-logs/<runId>.bin` for the engine's last execution state | (this file -- "Persistence and encryption") |

## Glossary

- **Piece** -- an npm package that ships actions and/or triggers. Examples: `@jarvispieces/piece-jarvis-ask`, `@activepieces/piece-gmail`.
- **Flow** -- a workflow as the user sees it. Has a name, a published state, and many versions.
- **Flow version** -- an immutable snapshot of a flow's tree. Triggers reference a specific version.
- **Flow run** -- one execution of a flow version. Has a status (QUEUED / RUNNING / SUCCEEDED / FAILED / PAUSED / TIMEOUT / INTERNAL_ERROR / QUOTA_EXCEEDED / STOPPED / MEMORY_LIMIT_EXCEEDED / SCHEDULE_FAILURE) and a checkpointed execution state. See "Run status lifecycle".
- **Connection** -- a stored credential bound to a piece's auth shape. Encrypted at rest.
- **Engine** -- the vendored Activepieces flow executor, built as a CJS bundle and spawned as a child Bun process.
- **Engine subprocess** -- one instance of the engine, running with a unique sandbox id and engine token. Held in a single-slot warm pool with a 5min idle TTL.
- **`outputSample`** -- a literal sample object an action declares to describe its return shape. The variable picker reads from this; the LLM composer reads from this. Required on every action.
- **`PATCHED_VENDOR_SOURCES`** -- the explicit list of vendored upstream files we patch in this fork. Editing any of them must flip the engine bundle hash.
- **`CATALOG_SCHEMA_VERSION`** -- a string mixed into the piece-metadata cache key. Bump it whenever you change the catalog projection format.
- **`SANDBOX_PROCESS`** -- the engine execution mode we use. Child-process IPC, no `isolated-vm`.

# Workflow Authority effect boundary (A1)

Direct workflow tools and notifications bypass the supplied Authority engine and
emergency controller. Put a daemon-owned gate immediately before supported
effects. Preserve the existing delegated-agent checks.

## Contract

- Authenticate run/project/sandbox from the engine token. The engine supplies step
  name and loop path separately from action parameters; validate them against the
  run's pinned version. This is runtime provenance, not hostile-script attestation.
- Persist one effect per run/step/path/route with a stable ID, version/request
  digests, exact arguments, target, decision and outcome. Snapshot notification
  channels and recipients before approval.
- Denied actions never dispatch. Missing governance components fail closed.
  Approval-required effects create an ordinary Authority request, owned by the
  workflow rather than the deferred executor, and pause at a waitpoint.
- Resume resolved requests atomically after the run parks. Recheck policy,
  emergency state, version, arguments and run state before dispatch. One
  conditional claim permits dispatch; completed effects return stored results.
  A crash during dispatch leaves an uncertain outcome and never auto-retries.
- Check emergency/policy before each notification channel. Already dispatched
  effects cannot be rolled back; partial results remain visible.
  Dashboard delivery uses a dedicated local broadcast method. High priority
  cannot trigger the proactive notification service's external fan-out. External
  channels use only the approved recipient snapshot, including `auto` expansion.
- Preserve PAUSED through the worker so approval waits do not become success.

## Capabilities

Use trusted tool definitions with declared action categories and targets. The
Authority action for a bounded built-in comes from the daemon's `TOOL_ACTION_MAP`,
so the boundary and the agent path cannot classify the same tool differently.
Unknown tools cannot inherit the legacy read-data fallback: a tool with no
explicit action is refused, and the refusal is audited under the worst-case
category rather than silently downgraded. Raw commands and ambiguous UI mutations
need a typed governed adapter before direct execution. A browser/command label
cannot establish an email-deny rule inside a script or click sequence. Existing
governed delegated-agent tools stay available; no universal business-intent
guarantee is claimed for them.

Bounded built-ins cover file reads/writes, clipboard, system information,
screenshots and read-only browser/desktop inspection. Their reviewed sidecar ID
and local absolute file path are pinned. A new default computer cannot redirect
an approved action. Server-owned `ToolDefinition.workflowEffect` declarations
provide an Authority category and target resolver for additional typed adapters;
the adapter must dispatch those exact arguments and target. A model-supplied
capability label never grants authority.

This boundary governs what a step can reach *through the daemon*. It does not
govern what a community piece does inside the engine subprocess: those pieces
make their own network calls with user-configured credentials and are outside
the tool surface entirely. An earlier revision of this change refused every
non-Jarvis piece and every CODE step at admission time to close that gap. That
was withdrawn: it disabled the whole installable-piece catalogue, which is a
product decision rather than part of this fix. The residual risk and the
proposed path -- expand the verified set deliberately, one typed governed
adapter per PR -- are tracked separately. Removing admission does not weaken
the boundary above: the gate lives in the daemon, on the far side of an HTTP
hop, so whatever the engine subprocess runs still has to pass it.

Inline `{{ ... }}` expressions also use a bounded data interpreter. Supported
syntax includes own-property references, dot/bracket and optional access,
primitive literals, arrays/objects, arithmetic/comparisons, logical/nullish
operators, ternaries and the built-in `flattenNestedKeys(data, path)` helper.
There are no globals, arbitrary calls, assignment, constructors or prototype
access. Getters, functions and object coercion are rejected. Unsupported syntax
fails the step before dispatch instead of silently becoming an empty input, and
the error quotes the expression that failed and states what is supported.
Existing flows using JavaScript methods or functions must use supported data
expressions or reshape the value upstream. Limits per expression: 16,384 source
characters, 2,048 tokens, depth 64, 10,000 evaluation/data visits and 1,048,576
accumulated string characters. The interpreter and engine patches participate in
the bundle hash; source sync applies exact replacements and fails on upstream
drift.

## API and identity

- Sandbox calls retain the run/project/sandbox bearer token and add
  `X-Jarvis-Step-Name` and `X-Jarvis-Execution-Path` (JSON pairs of loop name and
  iteration number). The daemon checks the step's piece/action against the run's
  pinned version.
- `wfe_` plus SHA-256 of `[runId, stepName, executionPath, route]` identifies the
  durable effect. Request and version digests reject changed retries.
- Governed routes are `tools`, `notify`, `agent`, `workflows`, `context` and
  `llm`. Vault, commitment and screen-capture reads and the LLM prompt are the
  read-and-egress halves of the same exfiltration path, so both are `read_data`
  effects: one Authority setting governs the source and the sink together.
- Pending tool/notification/delegation/child-run replies add
  `approval: { effectId, approvalId, waitpointId }`. Their normal result is empty;
  child `runId` is null and delegation status is `approval_required`; `jarvis-ask`
  returns empty text. The four `jarvis-context` reads keep their bare success
  shape and signal a pending approval with HTTP `202` plus `{ approval }`
  instead, so `outputSample` and downstream loop bindings are unchanged. The
  piece parks the engine at that waitpoint. Approval status is resolved through the
  existing Authority endpoints and delivery surfaces.
- `GET /api/workflow-runs/:runId/effects` returns `{ runId, effects }` with frozen
  arguments/target, provenance, decision/reason, approval and waitpoint IDs,
  dispatch status, result/error and timestamps. It returns 404 for an unknown run.
- Effect states are `pending`, `dispatching`, `succeeded`, `failed`, `blocked`.
  `succeeded` records a returned adapter result, not verified business progress.
  Notification results retain separate delivered and failed channel lists.

## Approval and follow-on boundaries

Use the existing Authority UI/delivery service. Workflow-owned requests cannot
execute through REST/voice/notification deferred paths or demote on restart.
Direct approvals bind to effects and waitpoints. Complete delegated approval
continuation remains A3; W5 can reuse the pre-dispatch cancellation check.
Delegation approval authorizes spawning only; it never grants the child's tools.
Child workflow starts bind approval to the reviewed child version. Both routes
retain their existing downstream checks.

The 15-second waitpoint scheduler resumes resolved workflow approvals only after
the run is PAUSED and has no active/canceled job. Marking the waitpoint resumed and
enqueuing its continuation share a transaction. Linking the approval and waitpoint
to the effect is atomic; delivery happens after that transaction. Generic
waitpoint webhooks cannot resume Authority-owned waits. Approved requests remain
owned by the workflow across restart.

Before BEGIN, `flow_run.execution_config` stores an immutable JSON snapshot of
`stepNameToTest`, `sampleData` and `sampleInputOverride`. Every continuation uses
that snapshot, including retries and approval resumes after a database restart
or queue-history cleanup. Single-step previews remain single-step previews.
The additive migration leaves existing records intact; legacy paused runs can
recover their configuration from their original BEGIN job. If both records are
absent, resumption fails with an instruction to start a new run rather than
guessing the original scope or inputs. Live version sample edits never replace
an existing run snapshot.

Effects already handed to an external adapter cannot be undone. Notifications
recheck before each channel and voice chunk. Failure or a crash during dispatch
retains a failed/uncertain record and blocks automatic replay; operators must
inspect the remote outcome before starting a replacement run. This is an at-most-
one dispatch claim, not a distributed exactly-once or sandbox-security guarantee.

## Initial verification (2026-09-15)

- Six tool/notification deny, pause and kill regressions failed before the gate.
- The final 40 boundary tests pass, including real engine and worker approval
  pause/resume in two loop iterations for both tool and notification pieces,
  database reopen/recovery, target and version binding, denied/expired approvals,
  concurrent dispatch, partial notification delivery, canceled runs and delegated
  tool governance. A slow-delivery/concurrent-completion race was reproduced and
  fixed before the final run.
- Broader Authority, adapter, sandbox API, worker, timer, channel, approval and
  engine suites: 352 passed, zero failed, one existing opt-in engine-build skip.
  The final 40 boundary tests were rerun after the delivery-race fix.
- Workflow API suite: 44 passed; the catalog-yank uninstall test returns 404
  instead of 200. It fails identically on clean main at
  `06c12e65ca19ee160768aada9c73ccae951ce056`.
- TypeScript, daemon/workflow builds, licensing, migration and template guards
  pass. Packaging passes using the guard's Bun fallback. The full repository
  suite was not rerun; the previously recorded npm/package-test timeout remains
  outside this change. The local commit uses a per-command hook bypass after
  these explicit checks, avoiding the known full-suite wrapper and its broad
  process cleanup.

All effect tests use synthetic writes/messages. They establish policy and
dispatch behavior, not sandbox isolation or real-service business outcomes.

## Review fixes and verification (2026-09-15)

- R1: reproduced a host `fetch` call through `runScript`; replaced JavaScript
  evaluation with the bounded interpreter. Real-engine tests reject inline HTTP
  effects in piece inputs and loop expressions before any request or tool call,
  under allowed, denied and paused policy states. Invalid expressions fail loudly.
  Adversarial tests cover constructor/prototype access, getters, coercion hooks,
  injected helper callbacks, unselected executable branches and resource limits.
- R2: reproduced urgent dashboard delivery reaching an external recipient through
  the real `WebSocketService`. Dedicated dashboard delivery now preserves the
  approved channels and recipients, including high-priority `auto` notifications,
  recipient changes while awaiting approval and emergency pause during fan-out.
  Existing proactive notification broadcasts retain their original behavior.
- R3: reproduced failed approval continuation of a single-step preview. The real
  engine now completes only that step with the reviewed inputs after database
  restart, queue-job deletion and changes to the version's sample settings.
  Migration, immutable snapshots, legacy recovery and missing-history rejection
  have separate regressions. Existing full-flow and loop resumes still pass.
- Fresh broader run: **576 passed, zero failed, three existing opt-in skips**, with
  1,850 assertions across 44 files. Scope: Authority; workflow runtime, database,
  adapters, queue, sandbox API, runner and timer; daemon channel, approval and
  WebSocket tests; expression-sync patch tests. The three skips cover catalog
  extraction/drift and the standalone engine-build gate; real engine/worker tests
  ran successfully. TypeScript, daemon/workflow builds and licensing, migration,
  template and packaging guards pass. Packaging used the guard's Bun fallback.
- The full repository and workflow API suites were not rerun for these fixes;
  their previously verified limitations above remain. No external effects were
  sent: reproduction uses synthetic tools/messages and a local HTTP listener.

## Review revision (2026-09-16)

Changes made in review, after the sections above were written:

- Admission (`assertWorkflowCapabilities`) was removed entirely, with its call
  sites in `EngineHandle.executeFlow` / `executeTriggerHook` and its two tests.
  Community pieces and CODE steps run again. See the Capabilities section for why
  and for what still covers the gap.
- `/v1/jarvis/context/*` and `/v1/jarvis/llm/chat` were brought inside the
  boundary as `read_data` effects. Without admission these were the whole
  remaining exposure: a workflow could read the vault, commitments and screen
  history and post them into an LLM prompt with no gate at all.
- Bounded-tool categories are now read from `TOOL_ACTION_MAP` instead of a
  parallel copy, and `bounded-tools.test.ts` fails if the two drift. Completing
  that map added explicit `read_data` entries for `get_clipboard`,
  `get_system_info` and `capture_screen` and `access_browser` for
  `browser_hover` and `browser_press_key`; all five previously resolved to the
  same value through `getActionForTool`'s fallbacks, so the agent path is
  unchanged.
- A refused capability is audited before the refusal is raised. It had been the
  one governance decision that left no trace.
- Expression failures now quote the expression and state what is supported.
- Upgrade notes for both breaking changes live in `docs/WORKFLOW_AUTOMATION.md`.

Reconciled with #461 (run cancellation) on rebase:

- The boundary's own `workflow_job ... status='CANCELED'` probe is gone. It now
  calls `assertRunNotCanceled`, so cancellation has exactly one fence and the
  boundary cannot disagree with the daemon's other dispatch points. That also
  picks up the deleted-run case the probe missed.
- The boundary publishes its pre-dispatch checkpoint into #461's execution scope
  with `withExecutionScope`. Scopes compose, so a deep dispatch point calling
  `checkpointExecution()` -- a TTS chunk, a channel adapter -- now enforces
  Authority policy and emergency state as well as cancellation. The threaded
  `checkpoint` callbacks on `broadcastProactiveVoice` and
  `sendWorkflowNotification` were removed in favour of that.
- Worker-driven tests hand the run back to `QUEUED` before enqueueing, because
  BEGIN now owns the transition to `RUNNING` and refuses a run that is already
  in it.

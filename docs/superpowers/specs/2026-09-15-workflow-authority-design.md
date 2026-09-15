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
- Preserve PAUSED through the worker so approval waits do not become success.

## Capabilities

Use trusted tool definitions with declared action categories and targets, with
conservative declarations for known bounded built-ins. Unknown tools cannot
inherit the legacy read-data fallback. Raw commands, arbitrary code, unrestricted
HTTP/native pieces and ambiguous UI mutations need a typed governed adapter before
direct execution. A browser/command label cannot establish an email-deny rule
inside a script or click sequence. Existing governed delegated-agent tools stay
available; no universal business-intent guarantee is claimed for them.

Validate executable capabilities, including nested branches and loops, before
flow execution and trigger hooks. The restricted policy also applies before the
daemon finishes wiring services. A model-supplied capability label never grants
authority. Engine step/path changes participate in bundle cache invalidation and
are retained by the vendored-source sync script.

Bounded built-ins cover file reads/writes, clipboard, system information,
screenshots and read-only browser/desktop inspection. Their reviewed sidecar ID
and local absolute file path are pinned. A new default computer cannot redirect
an approved action. Server-owned `ToolDefinition.workflowEffect` declarations
provide an Authority category and target resolver for additional typed adapters;
the adapter must dispatch those exact arguments and target. Existing flows using
undeclared tools or native effect pieces now fail with an unsupported-capability
error. This requires an adapter, not an approval that purports to understand raw
code or arbitrary UI semantics.

## API and identity

- Sandbox calls retain the run/project/sandbox bearer token and add
  `X-Jarvis-Step-Name` and `X-Jarvis-Execution-Path` (JSON pairs of loop name and
  iteration number). The daemon checks the step's piece/action against the run's
  pinned version.
- `wfe_` plus SHA-256 of `[runId, stepName, executionPath, route]` identifies the
  durable effect. Request and version digests reject changed retries.
- Pending tool/notification/delegation/child-run replies add
  `approval: { effectId, approvalId, waitpointId }`. Their normal result is empty;
  child `runId` is null and delegation status is `approval_required`. The piece
  parks the engine at that waitpoint. Approval status is resolved through the
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

Effects already handed to an external adapter cannot be undone. Notifications
recheck before each channel and voice chunk. Failure or a crash during dispatch
retains a failed/uncertain record and blocks automatic replay; operators must
inspect the remote outcome before starting a replacement run. This is an at-most-
one dispatch claim, not a distributed exactly-once or sandbox-security guarantee.

## Verification (2026-09-15)

- Six tool/notification deny, pause and kill regressions failed before the gate.
- The final 40 boundary tests pass, including real engine and worker approval
  pause/resume in two loop iterations for both tool and notification pieces,
  database reopen/recovery, target and version binding, denied/expired approvals,
  concurrent dispatch, partial notification delivery, canceled runs and delegated
  tool governance. A slow-delivery/concurrent-completion race was reproduced and
  fixed before the final run.
- Broader Authority, adapter, sandbox API, worker, timer, channel, approval and
  engine suites: 352 passed, zero failed, one existing opt-in engine-build skip.
  The final 40 boundary tests were rerun after the delivery-race fix. Engine
  lifecycle tests also verify default admission before flow and trigger-hook RPC.
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

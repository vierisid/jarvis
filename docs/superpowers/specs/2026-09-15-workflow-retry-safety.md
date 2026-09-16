# Workflow retry containment

Branch: `fix/workflow-retry-safety`, based on main `06c12e65`.

## Problem and shipped behavior

A chat `manage_workflow run` previously inherited three queue attempts. If an
early step delivered an effect and a later step failed, retry began the same
workflow again. Lease expiry could also reclaim RUN_FLOW jobs regardless of
their attempt limit.

The queue now enforces one attempt for every RUN_FLOW job, both BEGIN and
RESUME, regardless of the caller's requested limit. This covers chat, manual
and preview runs, triggers, child workflows, and waitpoint continuations.
Other queue job types retain their existing retry behavior. Safe engine
acquisition retries before flow execution remain unchanged.

- Before claiming work, the queue retires older queued workflow retries and
  normalizes active workflow attempt limits. A legacy job that has never been
  claimed may still execute once.
- A RUN_FLOW lease is never stolen. Expiry does not prove the original worker
  stopped; long-running work can still complete on its original worker.
- At daemon startup, orphaned RUN_FLOW jobs become FAILED without dispatch.
  Their unfinished QUEUED/RUNNING/PAUSED runs become FAILED with an
  explanation, finish time and instructions to check effects before deciding
  on another run. Job and run changes commit together. Existing terminal run
  results and partial step outputs are preserved. A durable PAUSED result
  with an unresolved waitpoint or a matching, unattempted queued RESUME
  remains paused for its planned continuation. The latter covers a timer or
  webhook consuming the waitpoint before the original queue job finishes.
  The continuation payload must identify this run; any stored run, flow and
  version IDs must agree. Attempted, canceled or malformed jobs do not qualify.
- Executor failures preserve the original error and attach the same retry
  guidance. Chat `get_run`, run history and the existing run API expose the
  `failedStep.errorMessage` with the stored step outputs.
- A new queue job cannot restart a completed or failed run: BEGIN requires
  QUEUED, RESUME requires PAUSED, and both require the first queue attempt.
  A legitimate waitpoint continuation is a fresh single-attempt job.
- Normal engine completion distinguishes PAUSED from SUCCEEDED. A pause
  completes its queue job but retains the run's PAUSED status, outputs and
  null finish time. The handler skips sample capture until actual success.
  A queued continuation can run whether it arrives before or after the
  original job completes, without depending on another open PR.

This uses existing durable `workflow_job` and `flow_run` records. There is no
schema migration or new status enum. The daemon remains a single process;
boot recovery must run before polling, when the previous worker is gone.
A stuck live worker must be canceled/stopped, never replaced just because
its lease expired.

## Boundary with A1 and A4

This is immediate containment, not exactly-once execution or automatic
recovery. A queue error is not proof that a provider rejected an action.
Step outputs are not necessarily provider receipts. A deliberately created
new run has a new identity and can repeat effects; no endpoint added here
claims it is a safe retry. Existing per-piece retry settings, provider/client
retries and repeated independent trigger events are outside this queue fix.

PR #459 (`fix/workflow-authority-boundary`) is open and unmerged. Its supported
effect boundary owns `workflow_effect` records and `wfe_` identities derived
from run, step, execution path and route, with request digest and approval
provenance. This branch does not copy that ledger or depend on it. Its
single-attempt rule also applies to A1's approved continuation jobs.

A4's recovery work should extend that effect boundary, keeping this queue
containment in place:

1. Bind a logical operation to the original run/version, step/loop path,
   capability, exact target/arguments digest and decision provenance. A
   recovery request must retain that operation identity rather than allocate
   a new identity by silently creating another run.
2. Store dispatch intent before calling the provider and its receipt/outcome
   afterward. No database transaction spans the external call. A1's successful
   result checkpoint can be reused; `dispatching` after a crash is uncertain.
3. For a completed operation, return its recorded outcome without dispatch.
   For an uncertain outcome, reconcile using provider evidence, or require a
   recorded user decision when evidence is insufficient. Retry only where
   the capability supports an idempotency key or proves no effect occurred.
4. Recheck current Authority and emergency state before any permitted new
   dispatch. Record recovery decisions and links to resulting attempts and
   receipts for inspection after restart.

These are the follow-on contract requirements, not implemented recovery
features in this branch. No universal arbitrary code/HTTP/UI guarantee is
made. A4 must test actual supported effect receipts and reconciliation.

## Combining open PRs

Both A1 and Today also carry the pause-result contract now included here.
Keep one copy of that contract, including nullable finish time and clearing
it when a continuation starts. Preserve A1's immutable execution configuration.
The worker-driven engine regression now records that configuration through
its real BEGIN path, replacing A1's manual setup in that test; its executor
unit tests still need their configuration fixtures. After merging A1, three
setups in the `workflow effect boundary` describe of
`src/workflows/runtime/workflow-authority.test.ts` (six parameterized cases)
hand the worker a fixture run left in RUNNING by the direct boundary call; add
`updateRun(f.run.id, { status: 'QUEUED' })` immediately before each of their
`enqueue({ jobType: 'RUN_FLOW', ... })` calls. Production entry points already
start QUEUED, so no source change is needed.

PR #450 also edits queue recovery and the handler. Keep this branch's
`retireWorkflowRetries(ts, true)` before re-queuing other job types, and keep
#450's `reconcileCanceledRuns`, its legacy stranded-run repair and its
cancel implementation. Keep the shared PAUSED result and null finish-time
handling alongside the new handler entry guard. Union the queue tests and
their imports/helpers. In `src/goals/work-items.test.ts` (`Today work trace`),
the assertion after `recoverOrphanedJobs()` must become
`expect(getFlowRun(run.id)?.status).toBe('FAILED')`: a queued RESUME cannot
make an interrupted RUNNING execution safe. That run must fail with guidance;
a recorded PAUSED checkpoint remains resumable.
These combinations were exercised in isolated checkouts, without importing
either PR's commits into this branch.

## Verification

- The new regression reproduces a fake chat delivery twice on main and once
  with this fix; the later error and first delivery output remain inspectable.
- Queue tests cover caller overrides, legacy retries, lease expiry, BEGIN and
  RESUME interruption, terminal-result preservation, transaction rollback,
  and generic-job retry behavior.
- A separate process records a fake delivery and exits without queue
  completion. Two fresh-process boots retain the interruption and do not
  dispatch the job again, including legacy missing `flow_run_id` metadata.
- Handler tests exercise planned RESUME and reject a fresh dispatch against
  an already completed run without overwriting its result.
- Final workflow/chat/API tests: 247 pass, one existing opt-in skip, 11,420
  assertions across 22 files. TypeScript, daemon bundle and all four
  repository guards pass. Packaging guard used Bun.
- Isolated A1 combination: 83 final queue/handler/Authority tests pass;
  the preceding 50-test Authority and engine resume run also passes.
  Combined TypeScript passes. The Today combination passes 62 queue,
  handler and work-item tests after the documented resolution.
- The full repository suite was not run. The commit hook was replaced by
  these explicit checks for this commit because prior sessions established
  full-suite/package-wrapper hangs; no global hook configuration was changed.

### R1: preserve a queued continuation after consuming its waitpoint

Recovery now recognizes the durable handoff from a PAUSED run to its fresh
RESUME job. The original job still terminates without replay. Three
regressions failed before the fix, covering the real timer scheduler,
webhook route and legacy nullable `flow_run_id`. They now execute recovery
in a fresh process, preserve the job and payload across another reopening,
and run the continuation once through the worker and handler. Ten negative
cases retain failure for attempted/canceled jobs, incorrect identities,
BEGIN or unrelated jobs, malformed JSON and runs without a recorded pause.
Verification: 122 focused tests passed, followed by the final 39-test queue
run with fresh-process recovery. Isolated combinations passed 96 Authority
and 75 Today tests. TypeScript, daemon build and all four guards passed.
The full-suite and per-commit hook limitations above remain unchanged.

### R2: preserve a pause when the original job completes normally

The production executor returns an explicit PAUSED or SUCCEEDED result.
The handler retains PAUSED with no finish time, completes that queue job,
and accepts the planned continuation under the existing strict entry guard.
It also clears stale finish times on entry and avoids capturing partial
outputs as successful sample data. This matches the open Today/A1 contract
and works independently on this branch.

Four timer/webhook regressions cover continuations queued before and after
normal completion through the real queue, handler and production executor,
with only the engine subprocess stubbed. They verify retained outputs,
one synthetic delivery, one continuation, no partial sample capture and
cleared finish times. The real-engine backup/resume test now runs both BEGIN
and RESUME through the worker, using the webhook endpoint to enqueue RESUME.
All four timing cases, the executor status assertion and the real-engine
regression failed before the fix. Afterward, 145 focused tests passed across
seven files, followed by the final 14 handler tests with stale-time coverage.
TypeScript, daemon build and all four repository guards passed.
The isolated A1 combination passed 119 tests, including the real engine.
The Today combination passed 95 tests; its three real-engine tests skipped
because that checkout lacks the engine/piece build cache. Those three
tests passed on this branch and in the A1 combination. The full repository
suite was not run; the documented per-commit hook limitation still applies.

All effects in these tests are synthetic. Live delivery incidence and
provider reconciliation have not been measured.

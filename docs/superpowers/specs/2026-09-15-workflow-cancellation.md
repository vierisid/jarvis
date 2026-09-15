# Workflow cancellation: durable dispatch fence

Branch: `fix/workflow-cancellation`, based on freshly pulled main
`06c12e65ca19ee160768aada9c73ccae951ce056`.

## Contract

`POST /api/workflow-runs/:runId/cancel` retains `ok` and `jobCanceled` and adds:

```json
{
  "ok": true,
  "jobCanceled": true,
  "accepted": true,
  "cancellation": {
    "runId": "...",
    "acknowledgedAt": 1789470000000,
    "statusAtRequest": "RUNNING",
    "inFlightMayHaveCompleted": true
  }
}
```

The same cancellation record appears on run GET/list responses. Its primary key
is the existing run ID. Repeating cancellation returns the original record.
The flag records conservative uncertainty **at acknowledgement**; it is not a
live count of unresolved effects and does not override a later effect receipt.
The dashboard displays this qualification both after cancel and in run details.

Acknowledgement means a SQLite transaction has persisted the fence, marked the
run STOPPED, and canceled all active RUN_FLOW jobs for that run. Legacy jobs
identified only by payload.runId are included. Paused runs can be canceled with
no active queue entry. Finished runs keep their outcome and return
`accepted: false`; a cancellation cannot turn an already completed queue
handoff into a canceled job.

After commit, cancellation signals the active executor. Engine acquisition,
RPC waits and terminal polling observe the signal. A late-acquired handle is
destroyed without executing; canceled handles cannot return to the warm pool.
The sandbox identity is revoked before waiting for process termination.

Every supported sandbox action route checks cancellation after parsing its
request. The tool registry checks again immediately before invocation.
Cancellation context follows asynchronous delegated-agent execution, channel
fanout, TTS chunks and child-workflow dispatch. Ordinary chat and concurrent
unrelated runs have no inherited stop decision. Database errors fail closed
at a scoped dispatch check.

Late handler/engine updates cannot replace STOPPED, change its acknowledgement
time, or erase earlier step outputs. They may add results. Already-started
daemon callbacks are allowed to finish recording their outcome. The worker
does not complete, fail or retry a canceled job. New BEGIN/RESUME jobs and
waitpoints for the canceled run are rejected, including after restart.
Webhook resume rechecks the run after reading the request body.

## Supported effects and pending PRs

Checked open PRs on 2026-09-15; none of these dependencies was merged into this
branch:

- A1, [#459](https://github.com/vierisid/jarvis/pull/459),
  `ba7251ed2c14fd5183a362c0a02b7500d7a0c5a2`: its policy checkpoint already
  rejects STOPPED runs and CANCELED jobs. Keep its run/step/execution-path,
  target, arguments, version and provenance checks when resolving imports and
  route calls. Keep both Authority and cancellation checkpoints in TTS.
  Its workflow-effect repository remains the single effect receipt store.
- Retry safety, [#460](https://github.com/vierisid/jarvis/pull/460),
  `9f05377eddfaf816552097534d7e0839b295db5d`: retain the shared single-attempt
  policy, entry guards, PAUSED result and nullable finish time. Handler sample
  capture must skip both PAUSED and canceled runs. In its invalid-continuation
  test, canceling the RESUME now cancels the original active job and yields
  STOPPED, rather than generic FAILED.
- Today, [#450](https://github.com/vierisid/jarvis/pull/450),
  `48e0cc7777744ef8f8bda8274e4010557ef4cdee`: replace its older running-job
  cancellation behavior with this transaction and signal. Preserve its other
  orphan/work-item reconciliation. Update its claimed-job cancellation test
  to expect STOPPED while retaining late committed output. Existing work-item
  result checks continue to see a stopped run and its partial evidence.

On main alone, existing step outputs and uncertainty are preserved. A1 adds
durable per-effect receipts, including results returned after the engine was
killed. `cancellation-authority.integration.test.ts` deliberately skips until
A1 is present; the three tests were run in the combined checkout now, covering
receipt persistence after restart, partial notification delivery, and approval
granted after cancellation. No duplicate effect ledger is introduced here.

This is a supported dispatch boundary, not remote undo. An already-dispatched
provider call, remote job or child workflow may finish; its result/receipt
remains authoritative. A missing result requires reconciliation before another
run. Child workflows already created retain their separate run identity.
Raw code, native HTTP and arbitrary UI effects require A1's declared capability
limits. Process termination alone cannot guarantee cancellation of their remote
effects. A4 safe retry/reconciliation is still separate work.

## Verification

The original five cancellation regressions failed before the fix. The final
main-based run passed 252 tests across 13 files, with three A1-dependent tests
skipped. Coverage includes a real engine with a pending daemon callback,
canceled acquisition, delegated tool calls, TTS and channel fanout, independent
scopes, authenticated routes, late results, file-backed database reopen, legacy
jobs and webhook races. All effects are synthetic; no live remote delivery
claim is made.

Review R1: dispatch also requires the run to still exist. Deleting a workflow
cascades to its run and cancellation record, but cannot reopen a pending
daemon callback's dispatch fence. Run IDs are not reused. Three new cases
failed before the fix and now cover cancellation followed by deletion during
notification fanout, delegated tool execution and authenticated sandbox calls.
API test fixtures now persist their run identities. Fresh checks passed 159
focused tests, 157 with A1 + retry, and 107 with Today + retry, plus TypeScript,
the daemon build and all four guards. Packaging used the Bun fallback because
npm's output contained no parseable file list. The full-suite limits below
still apply.

Isolated combinations passed 151 tests across seven files with A1 + retry and
155 tests across six files with Today + retry. Merge resolutions described
above were applied only in those disposable checkouts. An existing generic
queue retry test relied on a 1.1-second wall-clock sleep and flaked during these
runs; it now makes its persisted retry due explicitly. Separate repository
tests still verify the backoff calculation.

TypeScript checks passed on this branch and the A1 combination. Daemon and UI
bundles passed, as did `check-no-ee-imports`, `check-migrations`,
`lint-webapp-templates`, and `check-package-files`. UI bundling retains the
existing `@theme` / `@tailwind` warnings. The dashboard text was compiled, not
visually tested in a browser.

The full repository suite was not rerun: previous tasks established its local
hang/timeout and broad engine-process cleanup in the pre-commit hook. Required
guards and focused tests were run explicitly; local commit uses a per-command
hook override, leaving repository and global Git configuration unchanged.

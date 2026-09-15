# W1: preserve workflow pauses through the outer worker

Branch: `fix/workflow-paused-status`, from main `06c12e65ca19ee160768aada9c73ccae951ce056` after `git pull --ff-only origin main` on 2026-09-15.

A successful queue job means its execution slice completed. The workflow can still be waiting. This change carries the engine's PAUSED result through the executor and handler, and keeps a due timer pending if it arrives before the engine publishes that pause.

## Run and job contract

- `FlowExecutorResult.status` is `"SUCCEEDED" | "PAUSED"`, optional for compatibility with existing executors. The production engine executor always supplies it. Executors that omit it retain their success behavior; engine failures still throw with partial outputs.
- On PAUSED, the handler persists steps and step count, clears `finishTime`, and completes the current queue job. It skips sample-data capture until workflow success.
- A continuation uses the existing run ID and a new `RUN_FLOW` job with `executionType: "RESUME"`. Starting it clears stale finish time while preserving the original start time and prior outputs.
- `UpdateRunInput.finishTime` accepts null. Storage already supports this; no schema migration is needed.
- The timer query excludes QUEUED/RUNNING runs before applying its 100-row limit, leaving their waitpoints pending because the engine creates the waitpoint before uploading PAUSED. Deferred timers therefore cannot fill the scan and starve later PAUSED runs. PAUSED runs resume through the existing atomic consume-and-enqueue transaction. Missing or terminal runs still have their timers retired. Repeated ticks do not enqueue a second continuation.

## Regression evidence

The real `@activepieces/piece-delay` action is exercised in PRODUCTION mode. TESTING mode calls its immediate `test()` implementation and would miss the bug. An eleven-second delay takes the engine's waitpoint path without an inline sleep.

`outer-worker-delay.test.ts` uses the real queue, Worker, handler, production executor, engine subprocess, sandbox API, SQLite records, timer scheduler and execution-state backup. It verifies:

1. The first queue job succeeds while the run stays PAUSED, with no finish time or post-delay output.
2. The pending TIMER waitpoint and compressed execution backup exist; partial sample data is absent.
3. After shutting down and recreating the runtime, API and database connection, the timer enqueues exactly one continuation. The test advances the scheduler's clock explicitly.
4. The resumed workflow succeeds with the original seed output unchanged, a resolved reference to that seed, and the delay action's resumed result. Exactly one BEGIN and one RESUME reach the handler; further timer ticks do no work.

This is runtime/storage restart coverage inside one test process, not a full daemon crash test or a live remote-delivery guarantee. Interrupted active-job recovery remains in #460.

The real-delay regression failed on main with `Expected: PAUSED / Received: SUCCEEDED`, then passed after the fix. Eight additional pause/status/timer regressions also failed before the fix and passed afterward. They cover early timer scans, timer/webhook continuations queued before or after original completion, stale finish times, and a real outer-worker webhook resume. Existing loop and execution-backup tests remain in place.

## Open PR integration

Related PRs were verified open and unmerged before implementation:

| PR | Head checked | Shared behavior to retain |
| --- | --- | --- |
| #459 Authority | `ba7251ed` | Authority waits, capability checks and effect identity |
| #460 retry containment | `9f05377e` | Single attempts, interrupted-job recovery and continuation guards |
| #461 cancellation | `1990da9a` | Cancellation signal, stopped-state persistence and late results |
| #450 Today work items | `48e0cc77` | Work-item/run relation and result synchronization |

The earlier opportunity, feedback, provenance and recall PRs (#454, #455, #456, #458) are also still open. Their code is not needed for this change.

The core result contract already exists in #460's R2 fix, and compatible versions exist in #459/#450. This branch reuses that contract and the relevant R2 regressions on main; it does not import the other PRs wholesale. When combining them, retain one status implementation and all their independent guards and synchronization. Keep W1's timer deferral and real-delay test. If #460 merges first, much of this branch's status diff will already be present.

Checked in isolated working trees containing the actual prior PR changes:

- Authority + retry + cancellation + W1: 110 tests passed, including Authority pause/resume and the real delay.
- Today + retry + cancellation + W1: 65 queue/handler/timer/delay tests and 21 Today work-item tests passed.
- TypeScript passed in both combinations.

## Verification commands and limits

R1 verification: both 100-row starvation regressions failed before the query change and passed afterward. Three added cases cover QUEUED and RUNNING backlogs, retained waitpoints becoming resumable later, and the 100-eligible-row batch limit. Fresh checks passed 41 focused tests, 63 Authority/retry/cancellation integration tests, and 68 Today/retry/cancellation integration tests. Each set includes the real outer-worker delay. TypeScript on this branch, daemon build and all four guards passed; packaging used its Bun fallback. Logs are `/tmp/jarvis-w1-r1-{red,focused,a1,today,types,build,ee,migrations,templates,package}.log`. The earlier broader verification below was not repeated for this query-only correction.

Run from the repository with Bun on PATH:

```bash
JARVIS_TEST_ENGINE_BUILD=1 bun test \
  src/workflows/timer-scheduler.test.ts \
  src/workflows/runner/handler.test.ts \
  src/workflows/runner/engine-runtime/engine-flow-executor.test.ts \
  src/workflows/runner/engine-runtime/end-to-end-resume.test.ts \
  src/workflows/runner/engine-runtime/outer-worker-delay.test.ts

bun test \
  src/workflows/queue/queue.test.ts \
  src/workflows/api/routes.test.ts \
  src/workflows/sandbox-api/sandbox-api.test.ts \
  src/workflows/sandbox-api/worker-rpc.test.ts \
  src/workflows/runner/engine-runtime/execution-state-loader.test.ts
```

Initial verification passed 38 and 163 tests respectively, with no skips or failures. TypeScript on this branch, the daemon build, EE-import guard, migration guard, template lint and package guard also passed. The package guard used its Bun fallback because npm produced no parseable file list.

Logs: `/tmp/jarvis-w1-{red,delay-red,green,broader,a1,today,today-work-items,types,a1-types,today-types,build,ee,migrations,templates,package}.log` on the development host. The corrected real-delay red run is `delay-red`; the first combined red run also caught a test-fixture field typo, fixed before the corrected reproduction.

The full repository suite was not rerun because of the previously established package-wrapper/full-suite hangs. Local commits use an individual hook override after the explicit checks above; no Git hook configuration is changed. No UI files changed. This fixes future pauses; it does not guess how to repair historical runs already overwritten as SUCCEEDED with retired waitpoints.

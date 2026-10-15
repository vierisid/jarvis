# ON-B-08: durable first-workflow jobs

Default-off `build-job.v1`, with `activation-intent.v1` and `compose-draft.v1`
required by the frozen manifest. The module imports no optional sibling. B11
owns registration and the release gate; B10 owns public draft verification and
opening. Construction performs no IO and starts no worker or timer.

## Bind and dispatch

Explicitly provision `initializeBuildJobStore(db)` on the **same workflow SQLite
database** B09 uses, then retain `createSqliteBuildStore(db)` for that binding.
Inject current server authorization, a stable service-generation ID, live access,
B01's scoped `read`/internal `acknowledge` port, B07's `validate`, and B09's
`compose`/`reconcile`. Bind B09 to the same server-selected scope, never client IDs.
The database identity and generation are checked again around asynchronous work.
Missing services have no production mock or fallback.

The B11 binder maps only these public operations:

- `build.submit` → `provider.submit(context, { schemaVersion: 1, journeyId,
  intentId, submission })`, using B07's exact Create submission and intent ID.
- `build.read` → `provider.read(context, { schemaVersion: 1, jobId, after? })`.
  `requestId` can replace `jobId` to recover a lost acceptance response.
- `build.cancel` → `provider.cancel(context, { schemaVersion: 1, jobId })`;
  it also accepts a request ID for an already accepted job.

The host explicitly calls `run(workerContext, { schemaVersion: 1, jobId }, signal?)`
or `runNext(workerContext, signal?)` from its authenticated worker lifecycle.
`runNext` processes at most one eligible scoped job per call. Use a fresh server
worker context with live scope/access checks, **not the submitting HTTP request or
its disconnect signal**. A host shutdown signal interrupts ownership without
claiming user cancellation. There is no HTTP worker/start/phase/acknowledgement
operation, daemon registration, polling loop or scheduler in this module.

Defaults are a 30-second renewable lease, a 120-second total deadline beginning
with the first claim, and three composition attempts. Host overrides are bounded;
clients cannot set them. Reconciliation is read-only and bounded to five seconds.
Unknown result recovery backs off for one second. The host should schedule
`runNext` at its normal bounded worker cadence, including after restart. A lease
or elapsed timer can stop/fence work but can never create a successful result.

## Durable boundaries

The request is snapshotted and bounded before the first await. The actor/project,
versioned request digest and unique request key identify one job. Identical retry
returns that job even when validation is later unavailable; changed wording,
answers, reference order or journey conflicts. Corrected input or a deliberate
new attempt uses a **new request ID**. A terminal job never restarts.

B01's reservation must commit before the queued job and first event are saved
atomically. The job is then attached with `build_started`. A lost acknowledgement
is recognized from current journey state; no durable job is composed until that
attachment is confirmed. Terminal acknowledgement is a separate retryable saga:
the job remains saved/terminal if B01 is temporarily unavailable. A request whose
reservation committed but whose job insert failed can be retried with the same
body/key. A missing job read is never proof of cancellation or absence of effects;
this provider does not release an unaccepted reservation on that evidence.

An immediate SQLite transaction grants one lease token. Every B09 save must call
the supplied synchronous `mayCommit()` **inside B09's save transaction on this
same database**. Expiration, cancellation, timeout, shutdown, database replacement
and generation changes invalidate that permission. Heartbeats renew ownership;
they do not advance event revisions. A successor reconciles B09 before any model
work, so a crash after saving a flow recovers its exact durable association.

Cancellation immediately revokes the old lease and returns `requested`, with
`resolution: unknown`. The next worker reconciles under a new lease. A committed
draft wins the race and becomes `succeeded`; confirmed absence after fencing
becomes `cancelled`. An unavailable/mismatched recovery remains `working` with
`resolution: unknown`, a safe error, and the journey still reserved. It never
becomes a fabricated failure, cancellation or successful draft. Failure and
timeout likewise require successful reconciliation before reporting no draft.

## Status and event contract

Authorized reads return the current status plus at most 64 ordered snapshots,
`cursor` and `truncated`. With a truncated history, replace display state with the
current snapshot before continuing from its cursor. Revisions only increase;
stale lease tokens, phase sequences and backwards phase transitions cannot
replace newer state. All events stay scoped to one exact job. Outcome vocabulary
is unchanged: queued, working, needs_input, succeeded, failed, cancelled. Result
resolution separately distinguishes pending/unknown/none/saved.

Understanding is reported while B07 validation runs; building spans B09's opaque
compose operation. Optional `onPhase(phase, sequence)` notifications can report
real validating/saving stages when the injected composer supports them. Current
B09 does not emit those callbacks, so this adapter does not invent intermediate
stages. Completion of all four stages is only reported after authoritative
recovery of the saved artifact. The status fields project directly to U08's
`BuildStatus`; the host supplies transport observations and action permissions.
B10 must verify current readiness and disabled activation before producing U08's
openable draft reference. This provider never publishes, enables, tests, runs,
sends, grants tools, or deletes a workflow.

Events carry identity/status, safe fixed errors and bounded missing-input hints;
they exclude the original prompt, answers, model errors, graph and captured
workflow output. The original request is retained privately in the durable job
for recovery. No raw service error is sent to a client.

## Verification and rollback

`bun test src/onboarding-next/build-jobs` checks double clicks, delayed competing
submits, cross-process claims, lease loss, crash/restart, event bounds, failed
acknowledgements, timeout, cancellation races, authorization changes and storage
rollback. Optional integration tests exercise actual B01/B07/B09 when physically
present; semantic assessment and model responses are deterministic fixtures.
The isolated module and B11 missing/removed-provider cases build independently.

The existing progress checkpoint `2410205462365531104`, Figma node `1097:48188`,
remains the reference; there is no visual redesign. Live model/native and full
D/F/Q candidate evidence, production worker/binding assembly and B10 remain
release prerequisites. Disable/remove this provider and regenerate the runtime
catalog to roll back; retain jobs, events, journey reservations, receipts,
journals and drafts for authorized recovery. Never erase a draft on rollback.

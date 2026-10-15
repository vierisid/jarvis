# Optional onboarding diagnostics (ON-B-12)

`diagnostics.v1` is a default-off, injected event sink and operation observer. It
has no provider requirements, startup effects, selected log destination, analytics
client, network request, database writer or public HTTP operation. Importing its
manifest into the runtime catalog does not enable it or instrument the daemon.

## Bind and observe

The runtime owner can construct one sink with `createDiagnosticsProvider`, bind
its `probe`/`operations` to `diagnostics.v1`, and pass the same sink to operation
adapters. The sink's `authorize(context)` must resolve the current server owner and
project; never use client-supplied scope fields. Do not capture one request's
authority in a long-lived provider. Authorization must be synchronous and local.

```ts
const result = await observeOperation(optionalSink, context, {
  schemaVersion: 1,
  eventId: observationId,
  kind: 'interview_turn',
  stage: 'interview',
  correlation: { journeyId, operationId, sessionId, turnId },
  model: { provider: 'usejarvis', profileId: serverProfileId },
}, () => interview.submit(command), {
  result: acknowledgement => classifyAcknowledgement(acknowledgement),
  error: error => classifyKnownFailure(error),
});
```

The example's identifiers, adapter and classifiers belong to the host. Use
`Completion`'s fixed outcome/failure vocabulary and authoritative acknowledgement,
never arbitrary exception text. A resolved promise is not proof of business
success. Without a classifier, the outcome is `unknown`. The wrapper invokes work
once, preserves the exact result or thrown error, and adds no retry, cancellation
or operation timeout. It measures elapsed monotonic time at the operation boundary
before classification. A broken clock yields `null`, not an invented duration.
Use `record(context, input)` for an existing authoritative observation with its
measured duration. Diagnostic timers only bound logger delivery.

One stable event ID identifies one observation. Re-delivering the same observation
deduplicates it; changing its normalized body conflicts and preserves the original.
Give a new attempt/observation a new event ID, even when it shares a request/job ID.
Deduplication is best effort within the retained window, not business idempotency.

## Payload and receipt

All six event families use fixed stage, outcome and failure enums. Step transitions
also carry from/to steps, build phases a fixed phase, and recovery a fixed action.
Failures distinguish model timeout/unavailability, transport disconnect, save
failure/timeout, authorization, conflict and dependency problems. A turn or job
that has not settled emits no completion; this sink does not infer a timeout or
failure from silence. Owner-defined timeouts must supply the outcome.

Projection occurs before retention or delivery. Extra fields are discarded. No
prompts, transcripts, error messages/stacks, credentials, email content, images,
flow graphs or arbitrary metadata are copied. Provider is a fixed category;
profile identity is hashed separately, never read from a credentials object.
Every correlation ID (including event, profile, journey, request, attempt, session,
turn, job, composition, flow and version) becomes a scope- and field-separated
HMAC pseudonym. Actor/project IDs and the correlation key never appear in output.
These pseudonyms support correlation; they are not authentication tokens or
metric labels. Use only the fixed categories for metrics aggregation.

`receipt(context, rawJourneyId)` reauthorizes access and returns a detached,
bounded projection, or `null` when unauthorized/missing. It includes the stage,
category, elapsed milliseconds, ordered observations, eviction/dedup/conflict
counts and delivery health. Receipts document observations, not workflow completion.
They are process-local snapshots, not durable business records or full histories.

| Bound | Value |
| --- | --- |
| Retained journeys | 32, evict least recently recorded |
| Events per journey | 32, with eviction count |
| Recent dedup IDs per journey | 128 |
| Pending logger deliveries | 32 plus at most one in flight |
| Raw ID length | 256 characters |
| Duration | Rounded milliseconds, capped at 24 hours; unavailable is `null` |
| Logger wait | Default 100 ms, configurable from 1 to 1,000 ms |

The key is generated lazily for each instance. A host may inject a secret key of
32–128 bytes for stable correlation across instances/restarts. Reuse is deliberate;
rotating it changes pseudonyms. Receipts are not persisted by doing this. Use an
injected local logger if retention beyond the bounded process lifetime is needed.

## Delivery, enablement and rollback

Logging is queued, not awaited by operations. Inject a nonblocking local logger;
a synchronous logger that monopolizes the JavaScript thread cannot be preempted.
Throw, rejection or timeout trips a per-instance circuit, aborts the active signal
and drops queued deliveries with counters. Later records still reach receipts.
There is no automatic retry or unbounded set of hung promises, even if the logger
ignores abort. Overflow drops delivery, not the receipt. Logger mutations cannot
change retained events. The logger receives only the sanitized event.

The factory defaults to disabled. B11's required closure excludes diagnostics, so
absence, disablement or delivery failure cannot deny onboarding readiness. This
card registers discovery only; production provider adapters still need explicit
injection at their owner boundaries. No new daemon binding, release permission or
UI cutover is installed. The real-B01 integration test demonstrates the binding
pattern using its SQLite adapter; remaining capability/release bindings there are
explicit test doubles.

Rollback removes the binding or calls `dispose()`: queued delivery stops and new
events are rejected, while retained receipts stay readable under authorization.
Already exported local logs remain untouched. Do not erase journey records,
profiles, sessions or created drafts. Removing the module also requires regenerating
B11's committed catalog with `bun run generate:onboarding-runtime`.

## Local verification

```sh
bun test src/onboarding-next/diagnostics
bun run src/onboarding-next/diagnostics/fixture.ts
bun run check:onboarding-runtime
bunx tsc --noEmit
bun run build:ui
```

The quick check prints redacted receipts for a successful synthetic journey, an
interview model-timeout journey, and successful work with a failed logger. It
uses local simulated acknowledgements and real elapsed time, not live models or
accounts. Unit tests cover privacy, bounded memory/cardinality, duplicates, scopes,
logger failure/timeout/overflow and result preservation. Boundary tests physically
isolate the module and remove it again. Optional integration tests use real B01
SQLite success/conflict acknowledgements and B11 dispatch; they skip when those
owners are absent. Missing live-provider/full-candidate evidence stays unverified.

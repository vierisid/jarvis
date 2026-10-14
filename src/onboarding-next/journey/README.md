# journey.v1 / ON-B-01

An optional, dormant provider. Its factory performs no I/O. Nothing registers it,
changes a feature flag, exposes a route or changes the legacy wizard. ON-B-11 owns
runtime registration and ON-U-10 owns the UI entry. No sibling onboarding or Brief
module is imported. The static manifest follows `handoff-contract-v1.json`.

## Integration ports

Call `createJourneyProvider({ authorize, persistence })` from the authenticated
server context. `authorize` is re-evaluated for every operation and returns the
server-derived actor/project or null. Never derive these from a request body.
`createSettingsJourneyPersistence` adapts the existing vault `settings` table:

- `databaseForScope(scope)` must resolve the authorized actor's existing vault.
- `readLegacy(scope)` must synchronously read authoritative current user-settings
  and profile status in that same vault/transaction. Use `loadUserSectionStrict`
  for settings and the current profile service. It must throw on failed reads,
  corrupt rows or unavailable status. Do not pass the old UI hook's synthetic
  incomplete fallback, or an unverified/stale client status.
- `transaction` uses SQLite `BEGIN IMMEDIATE`, so identity initialization,
  revision checking, retry receipts and mutation commit atomically across tabs,
  daemon instances and database connections. Alternative injected persistence
  must preserve those semantics and roll back on any thrown exception.

`read()` imports legacy status once into a stable journey. Existing completed or
fully skipped users map to `exited` / `legacy_completed`. Incomplete setup maps to
Welcome, incomplete interview to Interview, and remaining tour to Tour. Legacy
room IDs are retained separately for ON-B-06 to interpret. No numeric screen index
or legacy room ID is interpreted as a new room. No legacy flag is deleted or
written. Future schema/state values return `unsupported` and remain untouched;
unknown additive fields on known records survive writes.

`transition({journeyId, expectedRevision, requestId, command})` accepts only
navigation, `replay_tutorial`, `explore` and `finish`. Replay is the sole reset
operation in this provider. There is deliberately no full/profile/setup deletion
operation. It resets only tutorial progress, retains completion, setup, interview,
job and draft identities, and returns to the prior location when the tour ends.
It clears the journey's copied legacy tour-step hint too, without changing the
original legacy settings row.
Finishing an ordinary tour leads to Activation. Explore first explicitly exits
without creating a workflow; finishing Result exits after a draft acknowledgement.

`acknowledge(...)` is an INTERNAL port for successful work by the other providers:
setup, interview, tour, build reservation/recovery, job acceptance and durable authorized draft reads. Never
expose it as a public generic PATCH or forward an HTTP body to it. ON-B-02 must
acknowledge successful setup before Google; ON-B-04/05 must acknowledge persisted
interview completion; ON-B-06 owns room IDs; ON-B-08 owns job status and must
reconcile/retry its acknowledgement after a revision conflict; ON-B-10 must verify
the exact authorized flow/version before `draft_saved`. This provider stores
acknowledgements, not evidence that composition ran or that a workflow is runnable.
It never publishes, enables, runs or modifies a workflow, profile or connection.

### Build handshake and recovery

1. After validating/fixing the intent, ON-B-08 must first commit
   `reserve_build({buildRequestId})` through the internal acknowledgement port.
   Use its existing scoped request/idempotency key. Only a successful, currently
   matching reservation permits that provider to accept/enqueue the job. A retry
   returns the CURRENT snapshot: check its active completion and matching
   `buildRequestId`, not just `availability` or the historical `appliedRevision`.
   ON-B-08 must still enforce its durable request-key cancellation fence at acceptance.
   Reservation and Explore compete on the same journey revision; the loser cannot proceed.
2. Reservation persists the request key at Build with `jobId: null`. It is not
   evidence of queued or running composition. On restart, reconcile that exact
   key with ON-B-08; never mint a replacement because the response was lost.
   `build_started({buildRequestId,jobId})` attaches the accepted job only to the
   matching live reservation. Explore/navigation remain blocked while reserved,
   including after a refreshed read from another tab. Tutorial replay is allowed.
3. For a confirmed failed/cancelled attempt, ON-B-08 may acknowledge
   `build_finished_without_draft({buildRequestId,jobId,outcome})` ONLY after it
   has fenced further work and verified the durable result association is absent.
   A timeout, disconnected transport, cancellation request or failed read is not
   that proof. Null `jobId` requires durable rejection/cancellation of the request
   key so a delayed acceptance cannot create a job; a not-found lookup is insufficient.
   If a draft won a cancellation race, reconcile it through ON-B-10 and send
   `draft_saved` instead. The journey never deletes or rolls back a saved draft.
4. Recovery retains request/job/outcome in `buildHistory`, returns to Activation
   (or updates the return location during replay), and permits a new request or
   Explore. Reusing a released request/job identity, or acknowledging an old
   attempt against a new reservation, is rejected. Existing v1 jobs without a
   reservation remain recoverable with null `buildRequestId`; both identities
   may never be null. `buildRequestId` and `buildHistory` are optional on older v1 records.

These are injected progress contracts only. This card does not implement the job
store, cancellation/fencing or result reader; ON-B-08/10/11 must supply and verify
them before activation. No direct `build_started` call without a reservation is
accepted by this revision. The provider remains unregistered and default-off.

`interviewState` begins at the contract's nonterminal `connecting` value, then
records `done` or `skipped` on acknowledgement. This means unresolved interview
progress, not a connection started by the journey provider. All six contract
values are readable for compatibility; live session transport belongs to ON-B-04.
Setup/tour/activation states record progress independently. A build or result
arriving during tutorial replay updates its return location while preserving the
tutorial location.

## Retries and reconciliation

Use a unique request ID and the revision from a successful read. An identical
retry returns the CURRENT snapshot plus the original `appliedRevision`, including
after restart or further progress. Reusing a request ID with a changed command,
journey or expected revision is a conflict. A stale revision returns the latest
snapshot without writing. Re-read and reconcile before deliberately issuing a new
request; do not silently rebase user intent. The bounded lifetime ledger retains
2,048 transitions without eviction; reaching it returns `transition_limit` and
requires operator investigation rather than risking duplicate application.

BroadcastChannel messages are invalidations, never snapshots to trust. The host
re-reads and calls `reconcileJourney(previous, incoming)`. Older revisions cannot
replace newer display state. A failed read retains the last display snapshot with
`availability: unavailable`; initial failure has no synthetic snapshot. Block
mutations until a successful read. Discard the host cache on auth-scope changes.
There is no polling, subscription, BroadcastChannel or UI code in this provider.

## Storage, rollback and activation

The row key is `onboarding-next.journey.v1.<sha256([actorId,projectId])>`. This avoids
collisions and prevents old `saveUserSection('onboarding', ...)` writers from
erasing the journey. It is additive in the existing table, not a new profile store.
Rollback disables/unregisters the provider and retains this row and all legacy
settings, profiles, connections, jobs and drafts. It does not reverse side effects.

Legacy status is an initial compatibility projection, not a continuously merged
second authority. ON-B-11 must coordinate legacy/new write ownership on cutover
and any return from rollback; a legacy reset cannot silently overwrite a new
journey. Canonical service acknowledgements remain required. This PR neither
updates legacy flags for new progress nor changes old endpoints.

Activation is blocked on ON-B-11, ON-U-10, the selected provider closure and
candidate-bound ON-U-11/ON-B-13 plus D/F/Q evidence. The fixture host demonstrates
the packaging contract; it is not evidence that the absent production host works.
Missing runtime services must remain unavailable, never receive production mocks.

## Safe local check

With repository dependencies installed and Bun 1.4.2:

```sh
bun test src/onboarding-next/journey
```

The suite creates only temporary SQLite stores, advances and reloads progress,
races two processes, verifies retry recovery, replays the tour during a build,
and checks the exact retained job/draft IDs and legacy settings after rollback.
All model/OAuth/job/draft acknowledgements are synthetic. The SQLite transactions,
process race and vault/user-settings/profile integration are real. No production
data, paid providers, browser/desktop actions or network account grants are used.

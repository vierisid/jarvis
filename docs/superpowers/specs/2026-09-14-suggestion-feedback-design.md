# Durable suggestion feedback and composition

## Scope and choice

Extend `awareness_suggestions` with identity, feedback and composition relations.
Keep the existing suggestion ID as the opportunity ID, as C6 does. A separate
opportunity entity would split identity again; storing only flags would leave
acceptance and recovery untraceable. Use a durable composition job without holding
a transaction across an LLM call.

This branch starts at main `4f9453e7`. C6's goal-grounded proposals and C10's Today
work items are separate branches. This implementation runs independently and uses
their shared IDs without importing their unmerged modules.

## Records

| Record | Relation |
| --- | --- |
| `awareness_suggestions.id` | Canonical opportunity ID; retains proposal and context. |
| `suggestion_identities` | Durable versioned pattern key. C6's `context.opportunity.patternKey` uses an opportunity namespace. Legacy app pairs use a separate normalized, unordered pair key, excluding counts. |
| `suggestion_feedback` | Immutable ID, opportunity ID, request ID, kind, reason, payload and timestamp. Kinds: dismiss, interest, accept, retry. |
| `suggestion_composition_jobs` | One job per opportunity, acceptance feedback ID, immutable request, state, attempts, lease, error, workflow ID and version ID. |
| `flow.metadata` | Reverse references: `opportunityId`, `compositionId`, `feedbackId`. |

Upgrade backfills identities. Historical duplicates remain addressable; the
earliest `(created_at, id)` is canonical. Feedback resolves aliases to it and
flags from any alias remain effective. New automation proposals reuse the
canonical row, and the engine suppresses delivered or decided repeats. An
undelivered proposal may be emitted again with its original ID when observed;
C6's notification outbox owns timer-based delivery recovery. Independent error,
schedule and break rhythms retain their temporal deduplication. New reasons are
preserved; historical flags cannot supply a missing reason.

The accepted request stores the user-confirmed name, recurring job, expected
result, observation references and optional goal link. C6's bounded evidence
snapshot is retained; legacy proposals retain the trigger capture reference.
Observations are not proof of completed work. Inferred goal candidates are never
promoted to confirmed links. A supplied goal ID must exist and be active, with an
explicit relevance reason. Current reads hide inactive goal links; the acceptance
snapshot remains historical evidence of the original decision.

## API

All routes use the existing authenticated daemon boundary and work while capture
is paused or awareness is unavailable.

- `GET /api/awareness/suggestions/:id/learning`: `opportunityId`, proposal, status,
  observations, current `goalLink`, feedback history and `composition`.
- `POST /api/awareness/suggestions/:id/accept`: `{requestId, reason, name,
  description, expectedOutcome, goalId?, goalReason?}`. Saves acceptance,
  `acted_on` and one queued job atomically. Returns immediately without waiting
  for composition.
- `POST /api/awareness/suggestions/:id/retry`: `{requestId, reason}`. Requeues a
  failed job. Reusing the key never starts another attempt, including after that
  retry has finished.
- `PATCH /api/awareness/suggestions/:id/dismiss`: `{requestId, reason}`. Empty
  legacy requests remain supported with an explicit unspecified-reason value.
  Dismissal after acceptance returns 409 and preserves the existing job/draft.
- `PATCH /api/awareness/suggestions/:id/act`: legacy interest only. Requesting
  more information does not compose or execute anything.
- `GET /api/awareness/compositions?offset=0`: `{suggestions, nextOffset}`, in
  pages of 100, independent of recent notification history.
- `GET /api/awareness/routines?offset=0`: the same page shape for all canonical
  automation proposals, including undecided and dismissed proposals. Delivered
  proposals remain discoverable without an age cutoff; legacy aliases appear once.

Missing suggestions return 404; invalid input returns 400; changed acceptance or
reused keys with different feedback return 409. Identical repeated acceptance
returns the same job, including failed/completed jobs. Failure requires an
explicit retry with a fresh key. IDs are opaque strings.

## Composition and recovery

The worker starts with workflow composer dependencies independently of awareness
capture. It uses the same installed-piece catalog, tool schemas, specialist roles,
execution targets and LLM client as `manage_workflow`. Requests stay queued when
those dependencies are unavailable.

1. Claim a queued job with a unique lease token and five-minute deadline.
2. Compose outside database transactions. No execution or installation occurs.
3. Under the same live lease, atomically create a disabled flow, draft version
   and attachment. The LLM result cannot mutate live workflow state itself.
4. On failure, preserve the request, attempt count and error. Shutdown or an
   expired lease records an interrupted failure. Queued jobs resume on startup;
   interrupted calls require explicit retry to avoid repeated unrequested spend.

Each attempt carries an abort signal through the composer, tier router and
provider transport. Timeout and shutdown abort in-flight requests. Aborted
attempts cannot start another provider retry, failover, discovery turn or
one-shot fallback. Finishing an attempt also aborts transport work left behind
by a provider's own timeout. Already consumed provider usage cannot be undone.

A crash before the final commit leaves a recoverable request; a crash after it
leaves the complete relation. Flow creation and attachment roll back together.
Stale workers are fenced by lease token and state. Deleted drafts retain their
historical IDs and report `draftAvailable: false`; repeat acceptance never
silently creates a replacement.

The active dashboard and standalone Workflows room expose a Routine requests
tab. It collects the recurring job and useful result, supports an optional
explicit goal, saves dismissal reasons and lists proposals and saved requests
with error/retry controls. Review opens the attached draft in the same room.
The legacy overlay remains compatible, but is not required to reach this flow.
Acceptance does not send a duplicate chat composition command.

C10 execution remains a later explicit step: publish/lock the reviewed draft,
link that version to accepted work, run through existing approval controls, then
check the result. This acceptance grants neither execution authority nor verified
goal progress.

## Implementation and verification

Implement additive schema/alias recovery, acceptance APIs, the lease and atomic
attachment worker, then overlay review/retry. Verify with real database reopen,
concurrent acceptance, rollback fault injection, stale-worker fencing, retry
idempotency, transport cancellation, goal validation and active-room DOM/browser checks. The app-pair restart
regression must fail on clean main and pass on this branch.

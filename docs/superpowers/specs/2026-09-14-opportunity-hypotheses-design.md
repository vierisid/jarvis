# C6: Evidence-backed opportunity hypotheses

This atomic change replaces the app-pair automation suggestion with a conservative proposal contract. It reads existing captures and active goals, works while the other audit fixes are pending, and requires no LLM call. It does not change goal scores, compose workflows or grant execution authority.

## Scope and design choice

The first catalogue covers unpaid-invoice review, lead follow-up and recurring reports. These are hypotheses to validate with users, not claims that screen activity proves a business process. Other work can produce no useful suggestion. A bounded cue catalogue is inspectable and testable now; free-form model inference would need its own quality evaluation, while waiting for every upstream repair would leave the current app-switch claim in place.

The implementation has four steps: classify captures into minimal job signals; assess recurrence and possible goal relevance; persist a selected hypothesis with the existing suggestion identity; collect user validation and reports of actual work. Each step has a typed boundary and failure tests. No transaction spans external work.

## Observation and recurrence contract

`createCapture` atomically records any recognised signal with the actual database capture ID. App names alone never qualify. Matching examines at most 240 title characters and 2,000 OCR characters, using an explicit English business-cue catalogue. Existing transition/session event payloads are not assumed reliable and are not required. Capture retention can delete the original text/image; a derived ledger retains only a catalogue cue, app name, capture ID and timestamp for 14 days. It contains no raw OCR, titles, URLs or file paths. Historical capture rows created before this upgrade are not backfilled; new observations accumulate immediately.

Within each job family, observations separated by at least 30 minutes without another matching observation begin distinct episodes. At least three episodes on two UTC dates within 14 days are needed. Capture count, app switching, session IDs and elapsed screen time are not completion evidence. Future timestamps, observations older than 14 days and replayed capture IDs do not add support. Continuous activity across midnight remains one episode. Evaluations run at most once per five minutes per suggestion engine.

`JobHypothesis` schema version 1 contains:

- `assessedAt`, `patternKey`, `kind`, proposed job/outcome and user-validation question.
- Evidence references with representative episode timestamps, app names and recognised cues.
- Recurrence counts, observation range and explicit `observed_activity` basis.
- `goalCandidates`, supported only by a shared business cue in an active goal's text. Their basis is `text_overlap_requires_confirmation`; they are not goal links. Candidate titles/text reflect the assessment time.
- `feasibility.status = unverified`, with outstanding source access, output destination, authority, workflow preflight and model-profile checks.
- Explicit uncertainty about reading versus doing, job identity, completed repetitions, time saved and goal relevance.

Candidate ranking first uses the number of possible goal matches, then distinct observed days, then a stable key. These are deterministic ordering rules, not calibrated probabilities or business-value estimates. An empty result carries `no_job_evidence`, `insufficient_recurrence` or `already_proposed`; it must remain a valid product state.

## Durable identity and feedback

`opportunity_hypotheses.suggestion_id` is the existing `awareness_suggestions.id`. The proposal and suggestion are inserted atomically only when the candidate is selected for delivery; a higher-priority error does not consume the opportunity. A unique `job-v1:<kind>` pattern key prevents repeats across restarts, including after dismissal. Version 1 offers one validation proposal per job family per installation. It does not distinguish several businesses or processes within the same family; the user specifies the actual scope during validation. Future richer identities must preserve dismissal history rather than changing keys to bypass it.

The same transaction inserts a pending `opportunity_delivery` row. With awareness enabled, the daemon drains this notification outbox on startup, after publication and every 30 seconds, independently of new captures. Unavailable or failed transports retry after five minutes with the original ID and explanation. A two-minute claim lease coordinates workers and expires after a crash; each delivery attempt waits at most 30 seconds. Dismissed, interested and validated proposals are excluded from pending sends.

Delivery is recorded only when a WebSocket accepts a frame, an external channel reports a successful send, or the native notification sender exits successfully. It is transport acceptance, not a user read receipt. The delivery metric uses these outbox receipts, not the legacy flag that was set before invoking a callback. Upgrading an earlier C6 database backfills pending rows without trusting that flag. Previously shown but unacknowledged legacy proposals can therefore be shown once more.

Notification delivery is at least once: a crash after transport acceptance but before recording its receipt, or a transport completing after the attempt timeout, can cause a repeated notification. The opportunity ID remains unchanged. Recovery uses only notification transports; it does not re-emit `suggestion_ready` through the workflow event bus. The initial event is still emitted on publication, but this outbox does not guarantee recovery of workflow event publication itself.

The existing suggestion list and notification body remain compatible. The context includes the full hypothesis; the body explains the activity evidence, proposed output and uncertainty. Existing `/act` records interest only. It does not validate the job or establish usefulness. Existing `/dismiss` remains authoritative for suppression, even though its legacy request has no reason. New feedback captures reasons and is idempotent by `(opportunityId, requestId)`. Conflicting reuse returns 409.

## API

All routes use the existing daemon authentication and CORS boundary and remain readable while the awareness service is stopped. GET requests do not publish proposals or mutate goals.

| Route | Result |
|---|---|
| `GET /api/opportunities` | `{opportunities, assessment}`. Stored opportunities plus current candidates/abstention. |
| `GET /api/opportunities/:id` | Stored opportunity, validation and feedback history. |
| `GET /api/opportunities/metrics` | Interest, validation, dismissal and reported-outcome counts, with denominators and evidence basis. |
| `POST /api/opportunities/:id/feedback` | `{feedbackId, opportunity}`. Invalid input is 400, missing opportunity 404, conflicting state/retry 409. |

Confirm a recurring job with a concrete expected result:

```json
{
  "requestId": "confirm-invoices-1",
  "kind": "validate",
  "job": "Review overdue customer invoices each Monday",
  "expectedOutcome": "A checked list of overdue balances and draft follow-ups",
  "goalId": "an-active-goal-id",
  "goalReason": "This is the collection work supporting our cash collection goal."
}
```

`goalId` and `goalReason` may both be omitted. A supplied goal must currently be active and requires a reason. The confirmed relation is labelled `user_confirmed`; it need not be one of the heuristic candidates. Validation is immutable; retrying the same request returns the original feedback ID. If a linked goal later becomes inactive or disappears, the current validation DTO returns `goalLink: null`, while feedback retains the historical confirmation. This path never writes a goal score or progress note.

Dismiss with `{requestId, kind: "dismiss", reason}`. Report an actual completed occurrence after confirmation:

```json
{
  "requestId": "invoice-review-outcome-1",
  "kind": "outcome",
  "workRef": "invoice-review/2026-09-21",
  "performedAt": 1790006400000,
  "useful": true,
  "note": "The checked list identified two overdue accounts without rebuilding it manually."
}
```

`performedAt` must be between confirmation and now. Replace the example timestamp with the actual occurrence time. `workRef` is an opaque reference to the real work record or deliverable, not a URL to fetch. It must be unique per opportunity. Unknown fields, empty reasons/references, malformed bodies and optimistic `verified` or score fields are rejected. A dismissal prevents new validation/outcome claims. No external URL is fetched and no action is performed from feedback.

## Dependency seams

- **C1/C2/C3:** capture persistence is the current canonical source. A repaired producer can keep using it without a C6 rollout. A future typed observation adapter must preserve capture identity/time and evidence basis. More complete observations improve coverage without changing inference to a completion claim.
- **C4/C5/C9:** every assessment reads current active goals. Confirmation resolves the current goal ID inside the write transaction. No goal mutation or progress inference depends on the unfinished goal-write contract.
- **C7:** stable `opportunityId` is already the suggestion ID. A later recoverable composition request/draft can reference it directly; interest, job validation and acceptance must remain distinct. Do not treat this feedback endpoint as a composition request or an execution approval.
- **C10:** use the same opportunity ID when relating a future work item to its proposal. This branch does not depend on the separate Today work-item branch.
- **W3/W8:** feasibility remains unverified until a particular draft/version, sources, bindings and environment have actual preflight and profile evidence. A piece catalogue listing or screen app name cannot establish feasibility. Completion of those contracts must attach their assessment to this opportunity, rather than reinterpret the historical unverified snapshot as supported.

This establishes the proposal contract now. Later draft/result attachment still belongs to the owning contracts; it is not simulated here. The new Brief UI can use the same API to show evidence and collect validation. This change supplies notification explanations and APIs, not a new Opportunities room.

## Useful-work evaluation

Metrics separate `proposed`, `delivered`, `interested`, `validated` and `dismissed`. Outcome metrics expose `outcomeReports`, `usefulReports`, `notUsefulReports`, `opportunitiesWithOutcomes`, `validatedWithoutOutcomes`, `recurringJobsWithOutcomes` (at least two distinct work references), and `usefulReportRate` (useful reports / all outcome reports, null when none). They are explicitly `user_report`; `verifiedResults` remains zero. Acceptance clicks and inferred episodes never count as useful results or saved time.

For a real-user pilot, show the dated evidence, ask whether it is a real recurring job and capture the corrected scope/output or dismissal reason. Observe at least two actual repetitions of each confirmed routine. Collect the work reference, outcome and useful/not-useful explanation for each; include rework and negative reports. Report the raw counts, missing follow-ups and rate denominator, and inspect the referenced deliverables with the user. Do not select only successful accepted proposals. Supported English cues and the deliberately limited catalogue must be reported as coverage limits.

Synthetic tests verify contracts, provenance, abstention, transaction rollback, inactive/unsupported goals, feedback idempotency, unchanged goal scores and fresh-process recovery. They do not establish usefulness on real users' work, workflow reliability, saved time or model quality. Those results require the pilot and later checked execution evidence.

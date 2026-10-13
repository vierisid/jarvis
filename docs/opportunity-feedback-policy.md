# Opportunity feedback policy

Q-14 adds `proposal-feedback-v1` at assessment and publication. It reads durable
proposal, delivery, decision and outcome records to suppress repeat noise and rank
eligible proposals. It does not execute work or change goal progress.

## Identity and suppression

Semantic identity is the supported job family, plus an allowlisted `daily`,
`weekly` or `monthly` cadence for recurring reports. App names, titles, proposed
wording and caller-supplied pattern keys cannot create a different routine.
Cadence comes from bounded report phrases in the existing privacy-guarded
classifier. Ambiguous cadence abstains; episode roles from different cadences
cannot be joined. Other material differences are currently unsupported.

An already proposed semantic routine stays suppressed, preserving prior durable
deduplication. Dismissal changes the recorded suppression reason, not its lifetime.
A historical report with unknown cadence overlaps every report cadence; it cannot
prove a materially different job. Historical rows are not backfilled.

A supported changed cadence is separately eligible after any related-family
cooldown expires:

| Evidence | Cooldown |
| --- | --- |
| Proposal or transport delivery receipt | 1 day |
| Acceptance or job validation | 1 day |
| Dismissal | 7 days |
| User-reported unhelpful outcome | 14 days |

Expiry is the recorded event time plus the duration. The latest active expiry
wins; reads and restarts do not extend it. Eligibility resumes exactly at expiry.
Only dated, non-future events within the last 90 days steer cooldown or ranking.
Legacy decision flags retain their meaning without inventing timestamps.

`publishOpportunity` rechecks the policy inside its immediate SQLite transaction,
so stale assessments cannot race a newly recorded dismissal. The first scoped
report retains the family storage key `job-v1:recurring_report` understood by older
writers. Its immutable hypothesis records the actual cadence. Subsequent distinct
cadences use scoped storage keys. Readers derive semantic identity from the
hypothesis, so storage compatibility does not erase the supported material change.

## Evidence and ranking

Evidence carries a source table and record reference. Sources are the existing
suggestion identity/context, owned hypotheses, delivery receipts,
`suggestion_feedback` and `opportunity_feedback`. If the F-09/F-10
`prepared_opportunities` table exists, its dated dismissal and acceptance columns
are read too. Q-14 does not import or activate preparation/acceptance code.

Interest and acceptance are decisions, not completed work. Delivery is a transport
receipt, not a user view. A valid outcome requires a boolean usefulness report,
nonempty work reference and valid performed/recorded timestamps. Duplicate
references within a semantic routine count once; conflicting reports for one
reference remain unknown. Invalid outcome rows are counted separately.

At least two distinct useful reports, forming a strict majority of the related
family's recent reported uses, supply a bounded priority boost of one. Current
goal evidence still ranks first; then the boost, recurrence days and stable key
break ties. The projection explicitly labels its basis
`related_routine_user_reports` and exposes source references. Reports about a
related routine do not prove the new variant will be useful.

## Quality reporting

`GET /api/opportunities/metrics` retains its existing fields and adds `quality`:

- Unique accepted/interested opportunities and reported uses.
- Useful-result numerator, denominator and rate; no outcomes means `null` rate.
- Proposed, accepted and validated opportunities without valid outcome feedback.
- Repeated useful routines, rejection reasons and source references.
- Later proposals for a dismissed semantic routine (`reappearanceErrors`).
- Undated dismissals, invalid outcomes and conflicting work references.
- `evidenceBasis: user_report`, `verifiedResults: 0`, `measuredTimeSaved: null`.

This is a census of retained records; it is not bounded to the 90-day ranking
window. A click never changes usefulness, time saved or goal progress. Assessment
also exposes suppression reasons, absolute cooldown expiry and abstention.
No saved/dismissed navigation, scheduling policy or F-11 delivery gate is added.

## Verification and limits

Run with the repository's Bun 1.4.2 pin:

```sh
bun run scripts/evaluate-proposal-feedback.ts
bun test src/awareness src/vault/awareness.test.ts src/goals/application-service.test.ts
bunx tsc --noEmit
```

The evaluator hashes 18 author-visible synthetic development cases, including
`changed-cadence-at-cooldown-boundary`, `clicks-are-not-usefulness` and
`conflicting-work-reference-is-unknown`. Tests cover real SQLite persistence,
disk restart, stale publication, older storage identities, optional prepared
decisions and unchanged goal state. They are policy checks, not field accuracy or
independent human evaluation. The prepared-schema probe validates the four-column
read contract only, not the full F-09/F-10 runtime stack.

Vocabulary and material-change detection are deliberately bounded English rules.
Unknown historical identity conservatively suppresses potentially useful variants.
Metrics read the full retained feedback census; large-database performance has
not been benchmarked. No production/native UI or paid-provider evaluation ran.

For containment, disable existing awareness. Roll back to the prior versioned
policy while retaining durable identities, feedback, privacy guards and user work.
The family storage key preserves older-writer deduplication. Never drop records or
replay effects to roll back. See [the delivery receipt](brief-delivery/Q-14.json).

# F15: explicit goal measurements

A score-only goal remains a score-only goal. A 0.6 score, a title containing “10 partners”, completed work or an accepted recommendation never supplies a count. A user can explicitly record six signed partners against a target of ten, with a source reference/version and measurement time. The existing GoalApplicationService is the only application writer; canonical goal reads and the Brief adapter expose the same stored measurement.

## Scope and activation

Prerequisite: F01. F15 has no additional activation dependency. Enable its authenticated Brief routes with `JARVIS_BRIEF_GOAL_MEASUREMENTS=1`. The flag defaults off and does not enable a dashboard room or F16 outcomes. Unmerged D/Q branches remain separate.

New source: optional additive `goal_measurement` and `goal_measurement_receipt` tables in the existing vault database. Existing goals receive no backfilled count. No workflow schema, second goal engine, provider calls, model inference, title parsing or automatic observation is added.

## Meaning and validation

Each full measurement snapshot contains:

- `unit`: trimmed plain text, 1–80 characters.
- `baseline` and `target`: finite values between -1e12 and 1e12, with distinct values. Decreasing targets are supported.
- `value`: an absolute observed value in the same range, or null when not yet known.
- `measuredAt`: UTC epoch milliseconds, no later than the current time. Required with a known value.
- `evidence`: the user's cited source `{ id, revision }`. The pair identifies a source version, not proof that a provider verified the report.

Unknown values require null time/evidence. They do not overwrite the legacy score, but their Brief progress is explicitly null/unknown. Observed zero has a timestamp and evidence and is displayed as zero. Once a known value is recorded, replacing it with unknown or an older/equal timestamp conflicts; a correction supplies a later timestamp and a fresh source version. Evidence references are retained as references and never fetched.

Every known value submitted through this writer has `qualification: user_reported`. No request can claim `measured`, and the request cannot set a score, health, event or qualification. The F01 wire type still permits a future independently verified provider to report measured data; F15 supplies no such provider.

The confirmed snapshot sets the canonical score to `clamp((value - baseline) / (target - baseline), 0, 1)`. This replaces the previous score; it is never added to it. Raw values stay intact beyond either bound. A new report correcting six to four moves a zero-to-ten goal from 0.6 to 0.4 once. Scoring a configured measured goal through the legacy score writer is refused; use a new measurement. A work-result check with `goalScore` for a configured goal returns an actionable 409; checking the work without `goalScore` still succeeds without changing progress. Unmeasured goals keep existing scoring behavior. Automatic daily reviews remain unable to score goals.

Parent and child goals are independent measurement scopes. No existing automatic rollup exists, and F15 adds none. A parent total may already include its children: adding them would double-count. Child reports, corrections, status changes or deletion therefore never mutate the parent's count or score. The same source may explicitly support independent goals; consumers must not sum ancestor/descendant snapshots. An automatic rollup needs a separate explicit disjoint-attribution contract.

## Durable writes and recovery

Call `GoalApplicationService.recordMeasurement(goalId, command)` or the gated HTTP route. The command has `requestId`, the current measurement `revision` (zero for no measurement), and the full `measurement` object. The transaction atomically stores the snapshot, absolute score, progress history, receipt and durable goal events. Health refresh uses the existing service, and canonical updated-at revisions advance even when writes share one clock tick, preserving existing freshness readers. Event delivery failure cannot undo an already committed receipt; a persistence failure rolls back every write.

Exact request replay returns its original receipt, including after restart or a later correction, without rolling the current goal back. Reusing the request ID with different content conflicts. The same source ID/version cannot be applied twice to one goal, even with a different request ID/time/value. Stale revisions and stale/equal observation times conflict. Competing writers serialize inside the existing immediate application transaction. Deleting a goal cascades its measurement/receipts along with existing goal data; durable events keep their established retention policy.

## HTTP and read contract

All routes use the daemon's existing authentication, return `Cache-Control: no-store`, and require the exact registered, ready, enabled provider.

- `GET /api/brief/goals`: every goal with its measured projection, from one database snapshot, for Today and both goal rooms. No query string.
- `GET /api/brief/initial-goal`: `{ state: "unplanned" }` when onboarding finished without the interview goal because the planner failed and no goal exists yet, otherwise `{ state: "none" }`. Creating any goal clears it. Today's empty goal card then says so and offers Goals. No query string.
- `GET /api/brief/goals/:id`: a BriefReadResult. Missing goal is empty; disabled/unavailable and unsupported are distinct. Ready data includes the F01 BriefGoal plus additive measurement definition/revision and progress.
- `POST /api/brief/goals/:id/measurement`: bounded 8 KiB JSON command. Returns the immutable measurement receipt. Invalid input is 400; concurrency/evidence conflicts are 409. Recover by request ID after an uncertain network response.
- `GET /api/brief/goals/:id/measurement?requestId=...`: returns `{ receipt }`, null if that request never committed.

For example, using a real goal ID and a measurement time at or before now:

```json
{
  "requestId": "partner-ledger-1",
  "revision": 0,
  "measurement": {
    "unit": "signed partners",
    "baseline": 0,
    "target": 10,
    "value": 6,
    "measuredAt": 1791324000000,
    "evidence": { "id": "owner:partner-ledger", "revision": "v1" }
  }
}
```

Use a new request ID, the returned measurement revision, a later observation time and a new evidence version to correct it. A receipt records the historical committed value; reload the current view after receipt recovery.

Canonical `/api/goals`, root, tree, children and detail reads add an optional `measurement` field, so existing clients still receive the original score/status/health fields. Every canonical goal query joins its measurement in the same SQL statement, so another process cannot produce a response mixing an old score/health/revision with a newer measurement. This also applies to overdue, dependency and escalation readers. Each goal is internally consistent; a recursively assembled tree does not promise one snapshot across different goals. Legacy records have measurement null. The Brief projection has `measurement: null` when unobserved, and explicit progress basis `legacy_score`, `unknown` or `measurement`. `progress.rollup` is `independent`.

## Counted measures (Q-17)

A goal can be measured by counting cited entries instead of a typed total: signed partners, customers, deals, hires. Its value is the number of distinct things whose latest entry counts them. Nobody types the number, so six signed partners trace to six entries, never to six workflow runs, six accepted tasks, a passed work result or a typed six.

What an entry is:

- `subject`: who or what was counted, as the person names it (trimmed plain text, up to 200 characters, no control characters). Things are compared without case, width, spacing or invisible formatting differences, so `Acme Corp`, `ＡＣＭＥ  corp` and `Acme` with a zero-width space before ` Corp` are one partner, and `Straße` is `STRASSE`. The comparison key is stored when the entry is written. Spelling variants (`Acme Inc.`) are not merged: the person corrects them. A subject with nothing visible is refused.
- `observedAt`: when it happened (UTC epoch milliseconds, not in the future), not when it was recorded. It is the person's statement, not checked against the entry it corrects.
- `source`: the cited source version `{ id, revision }`, such as a signed contract or a CRM record. It is a reference, never fetched or verified.
- `kind`: `counted`, or `retracted` to take a counted thing back out (a partner who backed out). A retraction is final until a later count of the same thing.
- `corrects`: the latest entry for the same thing, or null for a thing not seen before.

The rules, each enforced in the same immediate transaction as the write:

- A thing is counted once per goal. A second `counted` entry for it conflicts unless it corrects the thing's latest entry.
- A correction names the latest entry for the same thing on the same goal, and an entry is corrected at most once, so each thing keeps one lineage, oldest first. Correcting a detail (the date or the source) keeps the count, and may cite the same source version again; a retraction lowers the count; a new count after a retraction raises it again. A refusal says whether the named entry is on another goal, for another thing, or already corrected.
- A source version backs one counted thing at a time on a goal: one contract cannot count two partners. A thing taken back out frees its source, so a typo counted from the real contract is fixed by taking the typo back out and counting the right name from the same contract. The same source may support other goals.
- Exact replay of a request ID returns its receipt, including after a restart; reuse with different content conflicts.
- Entries are recorded by a person, or confirmed by one, so the measure's qualification stays `user_reported`. Nothing in this build records an entry automatically.

Defining a counted measure (`unit`, whole-number `baseline`, larger whole-number `target`, at most 1,000) replaces a typed total. Until its first entry the value is unknown, not zero (owner decision, 14 October): a typed total switched to counting keeps its legacy score and health, and the Brief progress reads unknown. Once the goal has any entry the value is the count, zero included. The baseline only sets where the progress scale starts: every counted thing needs its own entry, including those from before the goal. Defining it again keeps the entries and their count, and writes progress only when the score changes; the unit stays once the goal has any entry, a retracted one included. There is no way back to a typed total (owner decision, 14 October): on a counted goal, a typed total, a legacy score and a work result's `goalScore` are refused. A counted measure holds at most 1,000 things; a goal keeps at most 20,000 entries, and a retraction is still accepted at that cap so an overstated count can always be lowered.

Every entry updates the snapshot, absolute score, progress history (only when the count changes) and a `goal_measurement_recorded` event (`basis: observations`, `entryId`, `kind`, `corrects`) atomically. The snapshot keeps the IDs of the entries that count, so a read stays consistent with its own snapshot; receipts keep the snapshot without that list. Each known count is also a timed measurement receipt (request ID `entry:<entry id>`, evidence `observations:<goal id>` at `r<revision>`), so readers of measurement history see counted goals as they see typed totals; a definition with nothing cited yet is untimed, as an unknown typed total is.

Distinguishable by construction:

- Activity (an awareness or workflow note) is a progress note that moves nothing.
- Accepted and checked work keeps its own record and never creates an entry.
- A typed total (F15) carries `measurementDefinition.basis: reported` and one `source` reference.
- A counted measure carries `basis: observations` and one `observation` reference per counted thing, with IDs `goal_observation:<entry id>`, apart from the awareness observations that share the kind.

Parents and children stay independent, as for typed totals: a child's entries, corrections or deletion never change its parent, and a parent counts a thing only on its own entry. Automatic reviews stay inside the no-verified-mapping boundary: they cannot score a counted goal, and a passed work result cited by a review is rejected with `no_verified_score_mapping`. Recording entries automatically from a connected source needs its own tested mapping, explicitly installed; none exists.

Routes, under the same capability, authentication, `no-store` and 8 KiB body rules as above:

- `POST /api/brief/goals/:id/measurement/counted` with `{ requestId, revision, definition: { unit, baseline, target } }` returns the measurement receipt; recover it with `GET .../measurement?requestId=`.
- `POST /api/brief/goals/:id/observations` with `{ requestId, entry }` returns `{ entry, measurement, score, progressId }`; the count's timed receipt is recoverable with `GET .../measurement?requestId=entry:<entry id>`.
- `GET /api/brief/goals/:id/observations` lists every entry, oldest first, corrections included; `?requestId=` returns `{ receipt }`, null if that request never committed.

Invalid input is 400. A 409 says which rule refused the write: a thing already counted or already taken back out, a source version backing another counted thing, a correction naming an entry on another goal, for another thing or already corrected, retracting a thing not counted, a unit change on a goal with entries, either cap, an entry before a counted measure is defined, or a typed total, score or `goalScore` on a counted goal.

## D-track and F16 integration

D09 and goal-room adapters should pass `BriefGoal.measurement` through for qualified counts and data basis. Use `BriefGoal.progress.value` for progress; do not calculate it from a legacy score or from value/target alone, since nonzero baselines and decreasing targets are supported. A six-of-ten zero-baseline count maps directly to D09's existing qualified measurement shape. D09's present raw value/target band helper requires integration work for other baselines or decreasing targets; its preview is not live F15 integration. Do not activate it on unsupported cases by relabelling values. Keep user-reported qualification, source revision and as-of visible through the data-basis affordance. This PR does not bind or activate D09/D10/D25 presentation.

F16 can read the stored current snapshot, receipts and linked progress IDs. It must define attribution and windows before deriving outcome deltas and must never count both a parent and its children as independent benefit. A counted goal's timed receipts carry `basis: observations`; a typed total's carry none. F16 must treat a change of `basis` between two points as a changed definition, as it does a changed unit, baseline or target, so switching a typed six to a count of three is not read as a loss of three. The new `goal_measurement_recorded` event provides revision/request/progress identities through the existing goal outbox; it does not claim work execution or external success.

## Verify and roll back

```sh
bun test src/goals/measurements.test.ts src/daemon/api-brief-goal-measurements.test.ts src/util/model-exec-env.test.ts
```

Tests use isolated fixture databases and a local authenticated socket. They exercise the canonical writer, API, receipt recovery, restart, competing processes, negative corrections, independent hierarchy, old-schema migration, malformed requests and transaction failure. No live service, model or external effect is used. The review regressions commit a correction through the real writer in another process between fetching a goal and projecting it, covering nine canonical/Brief read paths. The environment inventory also verifies that the feature flag is classified as a setting and preserved in model-launched environments.

Disable the feature flag and restart the new runtime to stop Brief reads/writes. Retain additive tables, receipts, cited entries and existing recorded scores; an older build ignores `goal_observation` and reads a counted snapshot as a typed total whose one source is the goal's entry ledger at that revision (`observations:<goal id>`, `r<revision>`), or as an unknown measure before the first entry, so its reads keep working; it does not refuse typed totals on such a goal. A goal that took a typed total under an older build reads as typed again after the upgrade and refuses entries until it is defined as counted again. Do not drop evidence or downgrade to an older writer while measurements are active: an older binary does not enforce the measurement-backed scoring rule. New clients must respect unsupported/unavailable capabilities on an older server. F16 is not implemented here.

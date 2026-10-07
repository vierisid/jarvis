# F15: explicit goal measurements

A score-only goal remains a score-only goal. A 0.6 score, a title containing “10 partners”, completed work or an accepted recommendation never supplies a count. A user can explicitly record six signed partners against a target of ten, with a source reference/version and measurement time. The existing GoalApplicationService is the only application writer; canonical goal reads and the Brief adapter expose the same stored measurement.

## Scope and activation

Stack: `brief/f-15` on corrected F14 `1d4cf952aa3ade0abb198f4304ab28df80187063`. Compile prerequisite: F01. F15 has no additional activation dependency. Enable its authenticated Brief routes with `JARVIS_BRIEF_GOAL_MEASUREMENTS=1`. The flag defaults off and does not enable a dashboard room or F16 outcomes. Unmerged D/Q branches remain separate.

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

Canonical `/api/goals`, root, tree, children and detail reads add an optional `measurement` field, so existing clients still receive the original score/status/health fields. Legacy records have measurement null. The Brief projection has `measurement: null` when unobserved, and explicit progress basis `legacy_score`, `unknown` or `measurement`. `progress.rollup` is `independent`.

## D-track and F16 integration

D09 and goal-room adapters should pass `BriefGoal.measurement` through for qualified counts and data basis. Use `BriefGoal.progress.value` for progress; do not calculate it from a legacy score or from value/target alone, since nonzero baselines and decreasing targets are supported. A six-of-ten zero-baseline count maps directly to D09's existing qualified measurement shape. D09's present raw value/target band helper requires integration work for other baselines or decreasing targets; its preview is not live F15 integration. Do not activate it on unsupported cases by relabelling values. Keep user-reported qualification, source revision and as-of visible through the data-basis affordance. This PR does not bind or activate D09/D10/D25 presentation.

F16 can read the stored current snapshot, receipts and linked progress IDs. It must define attribution and windows before deriving outcome deltas and must never count both a parent and its children as independent benefit. The new `goal_measurement_recorded` event provides revision/request/progress identities through the existing goal outbox; it does not claim work execution or external success.

## Verify and roll back

In WSL:

```sh
cd /home/vierisid/.cache/codex/jarvis-f-15
bun test src/goals/measurements.test.ts src/daemon/api-brief-goal-measurements.test.ts
```

Tests use isolated fixture databases and a local authenticated socket. They exercise the canonical writer, API, receipt recovery, restart, competing processes, negative corrections, independent hierarchy, old-schema migration, malformed requests and transaction failure. No live service, model or external effect is used.

Disable the feature flag and restart the new runtime to stop Brief reads/writes. Retain additive tables, receipts and existing recorded scores. Do not drop evidence or downgrade to an older writer while measurements are active: an older binary does not enforce the measurement-backed scoring rule. New clients must respect unsupported/unavailable capabilities on an older server. Delivery evidence and baseline details are in `docs/brief-delivery/F-15.json` and its evidence directory. F16 is not implemented here.

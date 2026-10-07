# F16: outcomes with an explicit evidence basis

F16 projects existing checked work, workflow execution evidence and F15 goal observations. It does not infer business benefit from a successful run, a goal title, a legacy score, engine duration or `flow.time_saved_per_run`.

## Stack and activation

`brief/f-16` is stacked on corrected F15 `bc0fdf9cda343e45ad8081345a77e1814dbe979a`. The roadmap compile contract is F01; F15 persistence is an optional runtime seam, checked at readiness. No F15 measurement writer is imported by the outcome implementation. The existing F stack still contains its earlier compile dependencies. Enable both `JARVIS_BRIEF_GOAL_MEASUREMENTS=1` and `JARVIS_BRIEF_OUTCOMES=1` to expose the authenticated outcome routes. Both default off. D09/D10/D25 live presentation is not activated.

Pinned sources: A18 workflow schema, A08 work items and A09 goal application service at `69211511c95355776c6c319c01e1df5acd3b8f1e`. Current main inspected: `244658eed294af5d4b51de434d40cfd800adca67`. Those sources match the stack except F08 ingredient pins and F15 measurement writing/scoring protection. Existing work/run identities, result checks and effect records remain authoritative. No workflow schema, execution policy, provider call or goal writer is changed.

## Eligibility and attribution

An outcome requires an accepted work item, a passed user result check with cited evidence, and a matching completed commitment. Manual work is labelled one **checked work item** and carries no automation time claim. This is a user report, not independent provider certification or an inferred business result.

Workflow work additionally requires the exact linked production root run and version, a successful terminal run, a valid finish time before the result check, and no test-step or sample override. All descendant runs must also be eligible. Cancellation, outstanding waitpoints, failed/pending/blocked/dispatching/unknown effects and inconsistent effect receipts exclude the whole outcome. Effect arguments, outputs, waitpoint tokens and credentials are never projected.

A root run owns at most one outcome. The canonical work table already enforces unique run links. Projection also deduplicates run/check IDs globally before filtering by the window: a later work/goal link cannot count the same benefit in another day. Nested runs cannot count separately from their parent. An outcome's goal IDs are contextual links, not causal attribution, and do not multiply either count or time.

Current evidence is rechecked on every read in one SQLite read transaction. A subsequently invalidated run loses eligibility; retained time receipts alone cannot restore it. This is a current evidence projection, not an immutable historical dashboard snapshot.

## Time evidence and corrections

The optional additive `outcome_time_record` table is versioned per canonical work item. It stores a request ID, the exact result-check ID, an explicit manual-task baseline in minutes with source/version, and observed human review/intervention intervals with source/version. Baselines and intervals are user-reported evidence; the endpoint does not certify a stopwatch or fetch the cited source. Empty intervals explicitly attest that no human intervention was required, rather than treating absent telemetry as zero.

Time back is baseline minutes minus the union of the recorded intervention intervals. Overlapping intervals within the work are subtracted once. Engine duration, waiting time, run counts and the old per-flow default never supply a baseline. A missing baseline/intervention record produces null time, not measured zero. Negative values are retained to show overhead rather than hiding it behind a zero clamp. Shared intervention across different tasks is not inferred; each record must describe the complete required intervention for that work.

Time evidence is accepted only for eligible checked workflow work. The full command is strict, bounded to 100 intervals, with a baseline from zero to 10,080 minutes and intervals no longer than seven days each. Intervals must be within the work's lifetime and already observed. The immediate transaction compares the current revision and saves the immutable command receipt. An exact retry returns that receipt, including after restart or a later correction. Changed retries and stale revisions conflict.

A correction creates a new time-record revision and replaces that work's current claim. Aggregation uses only the latest revision and keeps the claim in the original result-check completion window. It never adds old and corrected baselines or treats the edit itself as new completed work.

Example command for an actual checked workflow work ID:

```json
{
  "requestId": "report-time-1",
  "revision": 0,
  "resultCheckId": "COPY-THE-CANONICAL-RESULT-CHECK-ID",
  "baseline": {
    "minutes": 30,
    "evidence": { "id": "owner:manual-report-stopwatch", "revision": "v1" }
  },
  "intervention": {
    "intervals": [{ "start": 1791360000000, "end": 1791360300000 }],
    "evidence": { "id": "owner:review-stopwatch", "revision": "v1" }
  }
}
```

The example's timestamps must be replaced with real observed times after the work was created and at or before now. This records 25 user-reported minutes of time back. Send a new request ID and current revision to correct it. Recover an uncertain write using its original request ID before creating another command.

## Windows, goal changes and coverage

All intervals are half-open `[start, end)` UTC epoch milliseconds. Custom reads accept at most 32 days and require an IANA timezone. The summary computes local today and the Monday-through-Sunday week, including 23/25-hour DST days and skipped calendar dates. UTC day lengths are never used to advance local boundaries. Only result checks at or before the current clock are counted. Optional `at` selects the calendar to inspect; the data still reflects evidence/corrections available now.

Time totals are null where no defensible records exist. The summary includes per-day coverage, eligible/untimed/timed work counts and reasons for excluded checked work. Coverage describes checked work in the requested window, not all activity on the machine. A partial total includes only the supported records. No eligible work or goal observations yields empty. Missing required source tables, a replaced database, a database error or exceeded read bounds yields unavailable instead of a fabricated zero.

The weekly `goalDeltas` and daily `todayGoalDeltas` use the final observation in their respective window minus the most recent observation strictly before that window. They retain signed corrections. A missing opening observation or changed unit/baseline/target produces a null delta with a reason and incomplete coverage. A configured baseline is not treated as a historical observation. Each goal, including parents and children, is separate; no cross-goal total or causal work attribution is produced.

Reads fail closed above 10,000 checked work items, 1,000 runs or 10,000 effects in one family, or 50,000 historical goal receipts. These bounds avoid silently truncating evidence and presenting the remainder as complete.

## API and dashboard integration

All routes use the daemon's existing authentication and `Cache-Control: no-store`. Capability registration, provider readiness and both activation flags are required.

- `GET /api/brief/outcomes?start=...&end=...&timezone=...`: the F01 `BriefOutcome[]` read contract, with additive coverage metadata.
- `GET /api/brief/outcomes/summary?timezone=...&at=...`: week/day time totals, seven local day buckets, checked work, separate goal deltas and coverage. `at` is optional; default is now.
- `POST /api/brief/outcomes/:workItemId/time`: a strict JSON time-evidence command, at most 32 KiB. Invalid input is 400, stale/conflicting evidence is 409, unavailable is 503.
- `GET /api/brief/outcomes/:workItemId/time?requestId=...`: `{ receipt }`, null when that request did not commit.

D09 must map this owner-produced summary to its view adapter, preserve `user_reported` qualification and coverage in data-basis detail, and omit unsupported values. The existing D09 preview requires nonnegative time values; a live binding must handle negative overhead and explicitly select a goal before activation. F16 does not add the removed weekly estimated label or change the approved headline. The UI remains gated pending that integration.

## Verification and rollback

In WSL:

```sh
cd /home/vierisid/.cache/codex/jarvis-f-16
bun test src/brief/outcomes.test.ts src/daemon/api-brief-outcomes.test.ts src/util/model-exec-env.test.ts
```

Tests use isolated fixture databases, real canonical work/goal writers and an authenticated local socket. They exercise missing evidence, correction/replay/restart, negative/zero time, overlapping intervals, descendant uncertainty, test runs, duplicate run bindings, timezone boundaries, independent goal deltas and malformed requests. No live model, provider or external effect is involved. Raw verification and mutation evidence is recorded in `docs/brief-delivery/F-16.json` and its evidence directory.

Disable `JARVIS_BRIEF_OUTCOMES` on the new runtime to stop reads/writes; retain additive time receipts and existing canonical work/goal data. Disabling F15 also disables outcomes through the capability dependency. This PR remains unmerged and does not enable a release. F17 is not included.

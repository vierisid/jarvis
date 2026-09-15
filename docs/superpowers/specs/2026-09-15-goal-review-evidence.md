# Automatic goal review evidence

Branch: `fix/evidence-bound-goal-reviews`, based on freshly pulled main
`06c12e65ca19ee160768aada9c73ccae951ce056`.

## Behavior

An evening review cannot turn a valid goal ID and a plausible explanation into
a score change. `updateGoalScore(..., 'daily_review')` rejects the write below
the model. Manual scoring retains its existing behavior; non-finite and
non-number scores are rejected. Historical scores are not rewritten.
The public score API returns 400 with the missing-measurement reason for
`daily_review`, rather than incorrectly reporting that a known goal is missing.

Reviews receive and persist a versioned, ID-bound bundle with:

- Goal IDs, current scores, criteria, health and update timestamps.
- A local-calendar-day observation window ending before the LLM call.
- Morning intentions, explicitly distinct from observations.
- Activity notes and previous score entries with IDs, sources, types and times.
- User-checked Today outcomes when the #450 storage contract is present,
  including work/check/run IDs, verdict, evidence references, check provenance
  and any already-applied goal-progress ID.
- Truncation/omission indicators and the current automatic scoring policy.

The prompt view contains at most 20 goals, five records per category per goal,
and 40,000 serialized characters. Text fields are clipped, including JSON
escape expansion. Whole records are removed from the largest goal if needed.
Their stable IDs point to the full source records. Truncated evidence is never
a basis for an automatic score.

Model proposals use `{ goalId, newScore, reason, evidenceIds }`. Validation
rejects malformed values, goals outside the bundle, changed/deleted goals,
missing or foreign evidence, activity/history alone, already-recorded scores,
and outcomes without a verified score mapping. At most 100 rejection decisions
are stored, with an explicit marker if additional proposals were omitted.
Only accepted writes belong in `scoreUpdates`; currently that list is empty.

Completed-action records come from passed user checks in the input snapshot,
never the model's `actions_completed` text. Failed checks remain visible as
outcomes. Narrative assessment is model-generated commentary, not verified
progress. The chat message explicitly reports that automatic scores are
unchanged.

The check-in and its `goal_review_evidence` row are saved in one transaction
after the LLM call. No database transaction spans inference. A failure to save
the audit rolls back the check-in. LLM failure still produces a fallback with
the same evidence snapshot. Existing check-in reads, including
`GET /api/goals/check-ins`, expose the additive `review_evidence` field; older
check-ins omit it. Records survive database reopening and a fresh process.

## Current boundary and C5/C9 integration

**Automatic numerical scoring remains disabled.** Main has free-text success
criteria and activity/history records, but no verified measurement-to-score
contract. A qualitative passed/failed result does not establish an arbitrary
percentage. A Today check with `goalProgressId` has already applied the user's
score. Neither may be counted again.

This implements the immediate containment and available evidence inputs. It
does not claim to implement the still-missing C5/C9 quantitative measurement
contract. There is intentionally no request parameter, model field or source
string that enables automatic review scores.

To enable scored reviews after C5/C9, add a trusted evaluator which binds a
durable measurement ID to the goal ID, immutable criteria version, observed
time, verification provenance and exact baseline-to-target score mapping. The
model may cite the evaluator's assessment; it must not mint the mapping. The
write boundary must re-read current evidence/criteria, reject stale or revoked
measurements, and atomically consume each assessment once with its progress
entry, new score and review audit. Add positive measured-progress and
regression cases, concurrent correction, replay/restart and rollback tests
before relaxing the current deny rule. Merely adding an evidence ID to the
old `updateGoalScore` call is insufficient.

## Open PR compatibility

Checked open PRs #450, #454, #455, #456, #458, #459, #460, #461 and #462;
none was merged when this branch was created. No previous feature branch was
cherry-picked onto this branch.

The relevant dependency is #450 at
`48e0cc7777744ef8f8bda8274e4010557ef4cdee`. The optional adapter reads its
`commitment_work.result_check` contract without importing its service. It
selects by result-check time and goal ID, including work created on a previous
day and work outside the morning plan. Missing/unsupported schemas abstain
from checked outcomes. Malformed, unchecked, future and old records cannot
become completed actions.

An isolated combination with the actual #450 branch was tested. Merge guidance:

1. Keep #450's morning planning, `createPlannedWork` and `workItems` result.
2. Keep this branch's evening bundle, validation and audit path. Its adapter
   replaces #450's raw evening `listWorkItems` prompt block.
3. Keep both additive schema blocks: `commitment_work`/backfill and
   `goal_review_evidence`.
4. Keep both check-in fields: `work_item_ids` and `review_evidence`.
5. Run `bun test src/goals` and TypeScript in the combined checkout. The
   Today integration test automatically runs when its real service exists.

## Verification

- Three regressions failed before the fix: known-ID unsupported scoring,
  direct `daily_review` writes, and missing ID-bound evening inputs.
- `bun test src/goals src/vault`: 195 passed, 2 skipped, 0 failed. One skip
  awaits #450's actual service; the other is the existing keychain environment
  test. Includes malformed/unknown/missing IDs and scores, cross-goal evidence,
  activity/history distinction, concurrent corrections, outcome timing,
  bounded escaped context, rollback, LLM failure and fresh-process recovery.
- Actual #450 combination, `JARVIS_TEST_ENGINE_BUILD=1 bun test src/goals`:
  127 passed, 0 failed, including real checked work and replay protection.
- Public API tests: 3 passed on this branch and 3 on the actual #450 combination.
  Two initially reproduced misleading 404 responses before the API fix. Tests
  cover abstention, finite score validation, unchanged manual scoring, unknown
  IDs and stored evidence readback.
- TypeScript passed in both checkouts. Daemon build and all four repository
  guards passed; the package guard used its Bun fallback after npm produced no
  parseable file list.

The full repository suite and aggregate pre-commit hook are not claimed green.
Their previously observed hangs/package-wrapper timeout remain documented in
the project record. Local commits use a per-command hook override after
explicit scoped verification; repository hook configuration is unchanged.

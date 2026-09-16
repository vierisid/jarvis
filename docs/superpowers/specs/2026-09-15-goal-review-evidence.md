# Automatic goal review evidence

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
- User-checked Today outcomes, including work/check/run IDs, verdict, evidence
  references, check provenance and any already-applied goal-progress ID.
- Truncation/omission indicators and the current automatic scoring policy.

The prompt view contains at most 20 goals, five records per category per goal,
and 40,000 serialized characters. Text fields are clipped, including JSON
escape expansion. Whole records are removed from the largest goal if needed.
Their stable IDs point to the full source records. Truncated evidence is never
a basis for an automatic score.

The bundle and the Today work records share one untrusted-content block, so the
evening prompt carries a single visible data boundary around everything the
model did not write itself.

Stored morning actions are treated as untrusted JSON. Only nonblank strings
enter the intention list; objects, nested arrays, nulls and other malformed
entries are omitted before clipping. A malformed collection produces an empty
list. New snapshots set `morningIntentions.invalidActionsOmitted` and
`truncated` when invalid data was excluded, while preserving the original
check-in for inspection. Older snapshots may omit the new optional flag.
These omissions are not evidence that the user failed to act. Morning planning
now validates what it writes, so this path covers check-ins stored by earlier
versions, which hold unvalidated model JSON despite the `string[]` annotation.

Model proposals use `{ goalId, newScore, reason, evidenceIds }`. Validation
rejects malformed values, goals outside the bundle, changed/deleted goals,
missing or foreign evidence, activity/history alone, already-recorded scores,
and outcomes without a verified score mapping. At most 100 rejection decisions
are stored, with an explicit marker if additional proposals were omitted.
Only accepted writes belong in `scoreUpdates`; currently that list is empty.

Completed-action records come from passed user checks in the input snapshot,
never the model's `actions_completed` text. Only goal-linked checked work
reaches that list; the stored `review_evidence` beside it discloses what the
window and the context limits left out. Failed checks remain visible as
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
measurements, refuse truncated bundles, and atomically consume each assessment
once with its progress entry, new score and review audit. Add positive
measured-progress and regression cases, concurrent correction, replay/restart
and rollback tests before relaxing the current deny rule. Merely adding an
evidence ID to the old `updateGoalScore` call is insufficient.

## Relationship to Today work items

The evidence adapter reads the `commitment_work.result_check` contract directly
rather than importing the work-item service, so goal rhythms keep working
without the workflow schema. It selects by result-check time and goal ID,
including work created on a previous day and work outside the morning plan.
Malformed, unchecked, future and old records cannot become completed actions.

The evening prompt keeps the plan-scoped work narration, which carries the
in-flight records (decision, blocker, run status) that have no checked outcome
yet and therefore cannot appear in the evidence bundle.

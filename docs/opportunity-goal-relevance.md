# Q-12: Grounded opportunity goal candidates

`goal-contribution-v1` replaces the goal keyword-overlap matcher. A recurring job
can suggest at most one **unconfirmed** goal contribution. A goal candidate never
links the goal, changes its score, records progress, authorizes an effect or makes
a workflow Ready. Explicit user confirmation continues through the existing writer.

## Evidence and current goals

The policy consumes Q-11's structured routine hypotheses for six supported job
families. At least three ordered source/operation/output episodes on two UTC dates
must still have evidence within the existing 14-day window. All role references
are retained, and output references must agree with the hypothesis's evidence.
Legacy cue-only hypotheses remain readable but cannot establish a new contribution.
No raw screen content, app name, goal score or arbitrary source instruction decides
a goal link.

The entire declared goal path must be present, end at a root objective, and contain
only active goals with no completion timestamp. Missing/cyclic paths and expired
deadlines abstain. Each node's `updated_at` must be within the past 90 days and not
in the future. This is a versioned conservative freshness heuristic, **not proof of
recent human review**; ordinary canonical goal writes also update that timestamp.
It may exclude still-useful long-running objectives. No timestamps are refreshed by
this policy.

The existing vault reader supplies up to 1,000 goals, including inactive ancestors.
At that cap, relevance abstains with `incomplete_goal_context`, including when the
true total is exactly 1,000. This avoids selecting a winner from a possibly partial
set. The previous first-100 active-goal page is no longer used for ranking.

## Ranking and explanation

A bounded English outcome vocabulary maps each routine's proposed draft output to
a possible contribution. Invoice collection requires an unpaid/overdue/outstanding
qualifier (or explicit cash collection); generic billing-volume reduction and
supplier-payment settlement cannot borrow the reminder contribution. An explicit success criterion must match; a matching title
cannot override an unrelated criterion. When the criterion is empty, an operational
title may supply the required outcome. Description text can exclude a research,
negated or non-operational context, but cannot supply the outcome by itself.
The same exclusions apply to ancestors. Titles and criteria over 300 characters,
descriptions over 6,000 characters, and nullable legacy text abstain without throwing.
Overflow is not truncated into apparently positive evidence.

Within a declared path, a supported specific step takes precedence over its
supported ancestor. Across remaining candidates, an explicit success criterion
ranks above a title-only outcome. Equally supported candidates produce
`competing_goals` and their IDs, with no preferred link. Stable ID sorting only
orders those competing IDs; it does not choose a goal. Unsupported context produces
`no_supported_goal`. Missing or expired episode evidence produces
`insufficient_evidence`. Only `candidate` improves a proposal's existing priority;
more keyword matches no longer increase it.

The candidate includes the objective ID, path IDs/titles/revision timestamps,
required-outcome field/text, capture IDs for every role, a possible contribution,
and explicit uncertainty. For example:

> Invoice balances → checking balances or payments → invoice reminder draft.
> Reviewed reminders could help collect outstanding balances; this may support
> “Reduce overdue invoices to zero.” Confirm that this work serves the goal.

The declared hierarchy is provenance supplied by the user, not proof that the
child causes the objective. Account/customer ownership and business impact cannot
be inferred from the minimal routine ledger. Two competing divisions can therefore
abstain rather than be assigned by app name. Unmarked research, negation not in the
bounded vocabulary and unsupported paraphrases remain limitations.

## Persistence, compatibility and scope

New hypotheses store additive optional `goalRelevance` and candidate `grounding`
fields. The new basis is `causal_contribution_requires_confirmation`; the type still
accepts historical `text_overlap_requires_confirmation`. No migration is needed.
`getOpportunity` and `listOpportunities` recompute inferred candidates from current
goals and evidence age without rewriting the saved hypothesis or suggestion.
Consequently renaming, pausing, completing, deleting or introducing a competing
goal changes the current projection, including after restart. A list loads its goal
context once. Stored suggestion context remains an immutable, timestamped discovery
snapshot, not a live goal projection; current relation consumers use the opportunity
reader. Existing composition only accepts user-confirmed goal choices and does not
consume inferred candidates.

A user may explicitly confirm an active goal that this conservative policy does not
recognize, or confirm no goal. Existing validation, feedback idempotency, dismissal,
composition, execution, delivery and score/event writers are unchanged. Current user
confirmations retain their existing active-goal rules; the 90-day inference heuristic
does not silently revoke a user's confirmation. No UI or Q-13 qualification work is
included.

## Verification and limits

```sh
bun run scripts/evaluate-goal-relevance.ts
bun test src/awareness src/vault/awareness.test.ts src/goals/application-service.test.ts
bunx tsc --noEmit
```

You can see this change in the evaluation JSON, then inspect
`invoice-outcome-not-title-overlap`, `current-objective-path` and
`competing-businesses`. The report contains labels, selected IDs, abstention states,
full explanations, provenance and a corpus hash. All 26 labeled development cases
pass: nine candidate links and 17 expected abstentions. One abstention is an explicit
known useful paraphrase miss. These are hand-authored, author-visible synthetic
policy checks, not measured field precision, a blinded holdout, independent human
review or a production accuracy certificate. No paid model evaluation was run.

SQLite tests cover restart, current read projection, nullable historical fields,
ancestor changes, the old pagination boundary, immutable history, explicit user
confirmation, and unchanged goal scores/progress/events. Q-11's recurrence, privacy,
delivery and retention tests remain in the affected suite.

Q-12 is stacked on Q-11 PR #967 at `8ea4bc6d`. The source card has no mandatory merge
or enable prerequisite; this implementation deliberately reuses Q-11's structured
evidence contract, so this PR now requires Q-11 first. Latest main `4aee7e6b` was
rechecked; its new catalog-license checks do not overlap these files. F-09 and Q-13
remain separate, unmerged integrations. Preserve Q-11's documented constraint-map
additions when integrating those branches. This card does not activate Brief or
identify/certify the deployed runtime.

Rollback: disable awareness for immediate containment. Restore the prior relevance
policy's ranking seam if needed, while retaining Q-11's privacy/recurrence guards
and current stale-goal filtering; alternatively return no inferred goal candidates.
Keep stored hypotheses, confirmation history and additive readers. Never drop data,
change goal scores or replay effects as rollback.

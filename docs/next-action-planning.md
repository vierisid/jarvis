# Next-action planning (Q-18)

What's next? recommends one action the founder can take now, asks a question,
or says that nothing new is worth adding. `src/goals/next-action.ts` decides
that. F-01's `recommendations` provider (F-13) must use it before reporting
ready.

The planner reads one snapshot and decides with a pure function. It makes no
model call and writes nothing. F-13 stores an accepted recommendation, creates
or links its work item and queues it. Accepting a recommendation is not goal
progress; only checked results move a goal. The ranking is a stated preference
order, not a measured optimum.

## Use

```ts
const plan = nextAction();               // observeNextAction() then planNextAction()
const plan = planNextAction(snapshot);   // pure, for tests and replays
```

`observeNextAction({ now, capacity, workLimit })` reads:

- every goal, with its parents, dependencies, deadline, health, order, score,
  latest progress entry and last activation (its first activation or a later
  resume);
- for each goal, the latest settled result of its work, however old: a result
  check, or the item closed in Tasks. Closing an undecided proposal as failed
  only dismisses it;
- open work: accepted and not settled, or proposed today and not decided.
  Rejected proposals and undecided ones from earlier days are not open, as in
  the Today view. It reads at most `workLimit` items (500), newest first, and
  counts the rest;
- open commitments that are not work items (pending, active or escalated);
- the titles of commitments finished in the last 30 days;
- the readiness of each workflow version that open work runs;
- for a waiting run, who resumes it: its own timer, an outside call to a webhook
  step, or you. Anything else, including an approval link and Jarvis's own
  approval before effects, counts as yours.

`capacity` is how many open items a day holds before new work is noise. It
defaults to 5; F-13 can pass the user's own limit.

## Result

| Outcome | Meaning |
| --- | --- |
| `recommend` | One action, with its goal and revision, evidence, rationale and the work item to link (or null to create one). |
| `ask` | A question whose answer unblocks a useful step, with the candidates it is about. |
| `none` | Nothing new is worth adding, and why. |

Every result has:

- `expiresAt`: 12 hours after it was made, or the soonest deadline on the
  chosen goal or a parent, if sooner;
- `basis`: a digest of every input except the clock. A run moving through its
  steps does not change it; a run starting, pausing or finishing does;
- `workload`: open items against capacity;
- `considered`: up to 20 alternatives, including doing nothing new, with why
  each ranked lower or was left out. Exclusions come before lower ranks, so the
  reasons a reviewer needs most survive the cut;
- `omitted`: open work past the observer's bound, and alternatives past the
  20 listed.

The goal revision is F-01's read projection, not a concurrency token: health
and escalation updates change it too. To tell whether a stored recommendation
still holds, F-13 compares `basis`, not the revision.

Rationales and questions quote blocker reasons and check summaries, clipped to
200 characters. For a failed run the reason is the failed step's error message,
which is outside text. Show it to the user as data, and frame it as untrusted
wherever plan text reaches a model, as `goals/rhythm.ts` does.

## Candidates and order

Finishing, unblocking and closing come before starting:

| Order | Kind | When |
| --- | --- | --- |
| 1 | `check_result` | A run finished and needs the user to confirm its result. |
| 2 | `resolve_blocker` | Accepted work waits on your answer, a failed run nobody settled, a missing run or a manual blocker. |
| 3 | `restore_capability` | Accepted work runs a workflow that is not ready, for example a disconnected account. |
| 4 | `decide_work` | A proposal from today waits for a yes or no. |
| 5 | `continue_work` | Accepted, unstarted work with nothing blocking it. |
| 6 | `close_goal` | A goal that looks done is still open. |
| 7 | `start_step` | An active task or daily action with no open work. |
| 8 | `review_goal` | A goal that is stale, has no active steps, or waits on something that can never finish. |

Within one kind, the soonest deadline on the goal or any parent comes first,
then the worst health on the goal or any parent, then the user's goal order
from the top goal down, then age, then title. The rationale names the field
that decided against the runner-up.

## Guards

- **Blocked work is never offered as doable.** A goal waits when it or any
  parent is not active, or when a dependency of it or of any parent is not
  completed. A parent waiting on one of its own steps does not hold that step.
  Accepted work, proposals, answers to waiting runs and new steps behind a
  hold are left out with the reason. Checking a finished run and settling a
  failed or missing run still go ahead: they record what already happened.
- **A dependency that can never finish asks for a fix.** A missing, killed or
  failed dependency, a goal depending on itself or its own parent, and goals
  waiting on each other get "Fix what ... waits on".
- **Waits that end by themselves are not offered.** A run waiting on its own
  timer or on an outside call to a webhook step counts toward the day, but
  there is nothing to answer.
- **No duplicates.** A new step is left out when its title matches an open
  commitment or open work item, ignoring case and punctuation. A goal with open
  work gets that work, not a new step.
- **No repeats.** A goal looks done when its steps are all complete, its score
  is 1.0, a commitment with its exact title was finished in the last 30 days,
  or, for a task or daily action, its latest settled work passed (checked, or
  marked done in Tasks), however long ago. It gets "Record whether ... is done",
  ranked above new steps, and new proposals for it are held back. Accepted open
  work on the goal overrides this. Above task level, a passed step is progress,
  and the planner asks for the next concrete step.
- **Stale goals get a decision.** An active goal with no progress, activation,
  settled result or accepted work for 14 days, or whose escalation suggests
  stopping, gets a review prompt instead of a new task, and its proposals are
  held back. Proposals are not activity: the fallback morning plan proposes the
  same goals every day.
- **Full days get no new work.** A day's load is its open work plus plain
  commitments due by the end of today, overdue ones included. When it reaches
  capacity, nothing that adds work is chosen; checking, unblocking, deciding,
  restoring and closing still are.
- **Ask instead of guessing.**
  - A goal above task level with no concrete step gets "What is the first
    concrete step toward ...?", or "the next" after a step was done.
  - A task whose last attempt failed gets asked whether to retry or change the
    approach.
  - Two new steps for different goals with no deadline, health or order between
    them get "Which should come first?". A question of the chosen goal's own is
    never replaced by this one. F-13 can keep the answer as goal order with the
    existing `reorderGoals`, which the planner already reads, so the same tie is
    not asked again.
- **Dates are the user's.** Dates in messages use the user's time zone.

## Evaluation

`src/goals/next-action-scenarios.json` holds 34 founder-review scenarios. They
include already-done work (recent, old, unlinked and closed in Tasks), stale
goals and stale proposals, an unavailable integration, a duplicate commitment,
blocked and inherited dependencies, a timer wait, an approval under a paused
goal, a parent's deadline, and full days. Each has a proposed expectation and
the reason for it. `src/goals/next-action-rubric.json` holds the review
criteria:

- useful;
- achievable;
- not a duplicate;
- explained against doing nothing and the runner-up;
- honest when unsure;
- respecting workload.

Both are `proposed` until the founder reviews them. Print the review packet with:

```bash
bun run scripts/next-action-review-packet.ts --out review-packet.md
```

## Limits

- Signals are the structured ones only: goals, work items, commitments, checked
  results and workflow readiness. Calendar, mail and facts are not read.
- New steps come from the user's own goal titles; a missing step is asked for,
  never invented.
- Plain commitments guard against duplicates, and fill the day only when due
  by its end; they are not recommended themselves. F-13 links work items.
- Title matching is exact after normalization; a reworded duplicate or a
  reworded finished commitment is not caught.
- Recurring work is not modeled: a goal whose work passed looks done until the
  user accepts new work for it or closes it.
- A wait the planner cannot attribute is treated as yours, because hiding an
  approval would stall the work.

## Quick verification

```bash
bun test --preload ./src/test-preload.ts src/goals/next-action.test.ts
```

Expected: 64 pass.

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

`observeNextAction({ now, capacity })` reads:

- every goal, with its parents, dependencies, deadline, health, order and latest
  progress entry;
- open work items, and work checked or closed in the last 7 days;
- open commitments that are not work items;
- the readiness of each workflow version that open work runs.

`capacity` is how many open items a day holds before new work is noise. It
defaults to 5; F-13 can pass the user's own limit.

## Result

| Outcome | Meaning |
| --- | --- |
| `recommend` | One action, with its goal and revision, evidence, rationale and the work item to link (or null to create one). |
| `ask` | A question whose answer unblocks a useful step, with the candidates it is about. |
| `none` | Nothing new is worth adding, and why. |

Every result has:

- `expiresAt`: 12 hours after it was made, or the goal's deadline if sooner;
- `basis`: a digest of every input except the clock, so F-13 can tell whether a
  stored recommendation is stale;
- `workload`: open items against capacity;
- `considered`: every alternative weighed, including doing nothing new, with
  why it ranked lower or was left out.

## Candidates and order

Finishing and unblocking come before starting:

| Order | Kind | When |
| --- | --- | --- |
| 1 | `check_result` | A run finished and needs the user to confirm its result. |
| 2 | `resolve_blocker` | Accepted work waits on an answer, a failed run nobody settled, a missing run or a manual blocker. |
| 3 | `restore_capability` | Accepted work runs a workflow that is not ready, for example a disconnected account. |
| 4 | `decide_work` | A proposal waits for a yes or no. |
| 5 | `continue_work` | Accepted, unstarted work with nothing blocking it. |
| 6 | `start_step` | An active task or daily action with no open work. |
| 7 | `review_goal` | A goal that looks done, has no active steps, or is stale. |

Within one kind, sooner deadlines come first, then worse health, then the
user's goal order, then age.

## Guards

- **Blocked work is never offered as doable.** A goal waits when it or any
  parent is not active, or a dependency is not completed. Its accepted work and
  new steps are left out with that reason.
- **No duplicates.** A new step is left out when its title matches an open
  commitment or open work item, ignoring case and punctuation. A goal with open
  work gets that work, not a new step.
- **No repeats.** A goal whose work was checked done in the last 7 days gets a
  prompt to record whether it is done, not the same step again. So does a goal
  whose steps are all complete.
- **Stale goals get a decision.** An active goal with no progress or work for 14
  days, or whose escalation suggests stopping, gets a review prompt instead of a
  new task.
- **Full days get no new work.** When open items reach capacity, a new step
  loses to doing nothing new; checking, unblocking and deciding still win,
  because they reduce the load.
- **Ask instead of guessing.**
  - A goal above task level with no tasks gets "What is the first concrete step
    toward ...?".
  - A goal whose last attempt failed its check gets asked whether to retry or
    change the approach.
  - Two new steps for different goals with no deadline, health or order between
    them get "Which should come first?".

## Evaluation

`src/goals/next-action-scenarios.json` holds 23 founder-review scenarios. They
include already-done work, stale goals, an unavailable integration, a duplicate
commitment, a blocked dependency and a full queue. Each has a proposed
expectation and the reason for it. `src/goals/next-action-rubric.json` holds
the review criteria:

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
- Plain commitments count toward the workload and guard against duplicates, but
  are not recommended themselves; F-13 links work items.
- Title matching is exact after normalization; a reworded duplicate is not
  caught.

## Quick verification

```bash
bun test --preload ./src/test-preload.ts src/goals/next-action.test.ts
```

Expected: 33 pass.

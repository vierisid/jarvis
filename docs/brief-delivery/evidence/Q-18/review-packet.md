# What's next? review packet

Planner `next-action-v1`, rubric `next-action-review-v1` (proposed), 34 scenarios (proposed).

For each scenario, read the situation and the planner's answer, then mark every criterion yes or no. Edit the proposed expectation where you disagree.

## Criteria

- **useful**: Does the action move an active goal forward, or close or unblock open work?
- **achievable**: Can the founder do it now, with nothing (a dependency, a paused parent, a missing integration) blocking it?
- **not_duplicate**: Is it free of duplication with open commitments, open work and work already checked done?
- **explained**: From the rationale alone, can you say why it beats doing nothing new and beats the runner-up?
- **honest**: Where the planner cannot know the right step, does it ask a useful question or abstain instead of inventing one?
- **workload**: Does it avoid adding new work when the day is already full?

Pass: Every scenario meets its expectation, and the reviewer answers yes to every criterion for every scenario. A no on any criterion is a defect to fix or an expectation to change.

## 1. check-finished-run

**Situation:** This week's invoice reminders ran and finished. Pricing work is also waiting.

**Recommends:** Check the result of "Send this week's invoice reminders"

Why, as the planner gives it:
- Its run finished, and only you can confirm the result; until then it counts for nothing.
- Serves: Collect overdue invoices > Send invoice reminders.
- Better than doing nothing new: it closes or moves open work.
- Ahead of the next option (Do "Draft the new pricing page"): checking finished work comes before continuing accepted work.

Alternatives weighed:
- ranked lower: Do nothing new. Better than doing nothing new: it closes or moves open work.
- ranked lower: Do "Draft the new pricing page". Ranked below: checking finished work comes before continuing accepted work.

**Proposed expectation:** recommend, check_result. A finished run is not progress until you confirm it. Checking is quick and closes the loop before more work starts.
**Planner meets it:** yes

Review: useful [ ]  achievable [ ]  not_duplicate [ ]  explained [ ]  honest [ ]  workload [ ]

Notes:

## 2. answer-waitpoint

**Situation:** The reminder run is paused, waiting for approval to send.

**Recommends:** Answer what "Send this week's invoice reminders" is waiting for

Why, as the planner gives it:
- Accepted work is stuck on this, and you are the one who can clear it.
- Blocked: Waiting at approve_send.
- Serves: Send invoice reminders.
- Better than doing nothing new: it closes or moves open work.
- Ahead of the next option (Do "Draft the new pricing page"): unblocking accepted work comes before continuing accepted work.

Alternatives weighed:
- ranked lower: Do nothing new. Better than doing nothing new: it closes or moves open work.
- ranked lower: Do "Draft the new pricing page". Ranked below: unblocking accepted work comes before continuing accepted work.

**Proposed expectation:** recommend, resolve_blocker. Accepted work is stuck on an answer only the founder can give.
**Planner meets it:** yes

Review: useful [ ]  achievable [ ]  not_duplicate [ ]  explained [ ]  honest [ ]  workload [ ]

Notes:

## 3. failed-run

**Situation:** The reminder run failed and nobody has looked at it.

**Recommends:** Find out why "Send this week's invoice reminders" failed and record the outcome

Why, as the planner gives it:
- Accepted work is stuck on this, and you are the one who can clear it.
- Blocked: Gmail rejected the request.
- Serves: Send invoice reminders.
- Better than doing nothing new: it closes or moves open work.

Alternatives weighed:
- ranked lower: Do nothing new. Better than doing nothing new: it closes or moves open work.

**Proposed expectation:** recommend, resolve_blocker. A failure nobody has looked at hides whether anything was sent; settle it before planning more.
**Planner meets it:** yes

Review: useful [ ]  achievable [ ]  not_duplicate [ ]  explained [ ]  honest [ ]  workload [ ]

Notes:

## 4. unavailable-integration

**Situation:** Accepted follow-up work runs a workflow whose Gmail account is disconnected. Another goal has a startable step.

**Recommends:** Fix what "Send lead follow-ups" needs to run

Why, as the planner gives it:
- Accepted work cannot run until this is fixed.
- Its workflow is not ready: send_followup: Connection is not active.
- Serves: Follow up with leads.
- Better than doing nothing new: it lets accepted work run.
- Ahead of the next option (Start "Update pricing page"): restoring what accepted work needs comes before starting a new step.

Alternatives weighed:
- ranked lower: Do nothing new. Better than doing nothing new: it lets accepted work run.
- ranked lower: Start "Update pricing page". Ranked below: restoring what accepted work needs comes before starting a new step.

**Proposed expectation:** recommend, restore_capability. Running it would fail. Reconnecting the account unblocks work already accepted, which comes before starting something new.
**Planner meets it:** yes

Review: useful [ ]  achievable [ ]  not_duplicate [ ]  explained [ ]  honest [ ]  workload [ ]

Notes:

## 5. decide-proposals

**Situation:** This morning's plan proposed two items, one for a goal due in two days.

**Recommends:** Decide whether to do "Send this week's invoice reminders"

Why, as the planner gives it:
- A proposal from today is waiting for your decision.
- Serves: Send invoice reminders.
- Better than doing nothing new: it closes or moves open work.
- Ahead of the next option (Decide whether to do "Draft the new pricing page"): it has a sooner deadline.

Alternatives weighed:
- ranked lower: Do nothing new. Better than doing nothing new: it closes or moves open work.
- ranked lower: Decide whether to do "Draft the new pricing page". Ranked below: the chosen option has a sooner deadline.

**Proposed expectation:** recommend, decide_work. Proposals need a yes or no before they are work; the one serving the sooner deadline first.
**Planner meets it:** yes

Review: useful [ ]  achievable [ ]  not_duplicate [ ]  explained [ ]  honest [ ]  workload [ ]

Notes:

## 6. continue-before-starting

**Situation:** Accepted reminder work is ready. Another goal has no work yet.

**Recommends:** Do "Send this week's invoice reminders"

Why, as the planner gives it:
- You already accepted this work, and nothing blocks it.
- Serves: Send invoice reminders.
- Better than doing nothing new: it closes or moves open work.
- Ahead of the next option (Start "Update pricing page"): continuing accepted work comes before starting a new step.

Alternatives weighed:
- ranked lower: Do nothing new. Better than doing nothing new: it closes or moves open work.
- ranked lower: Start "Update pricing page". Ranked below: continuing accepted work comes before starting a new step.

**Proposed expectation:** recommend, continue_work. Finish what was already accepted before adding new work.
**Planner meets it:** yes

Review: useful [ ]  achievable [ ]  not_duplicate [ ]  explained [ ]  honest [ ]  workload [ ]

Notes:

## 7. already-done

**Situation:** Reminder work was checked done two days ago, but the goal is still open. A pricing goal has a startable step.

**Recommends:** Record whether "Send invoice reminders" is done

Why, as the planner gives it:
- The goal looks done; recording that keeps your plan honest.
- Its work "Send this week's invoice reminders" was checked done on 2026-10-03, and the goal is still open.
- Serves: Send invoice reminders.
- Better than doing nothing new: it settles a goal that looks done.
- Ahead of the next option (Start "Update pricing page"): closing a goal that looks done comes before starting a new step.

Alternatives weighed:
- ranked lower: Do nothing new. Better than doing nothing new: it settles a goal that looks done.
- ranked lower: Start "Update pricing page". Ranked below: closing a goal that looks done comes before starting a new step.

**Proposed expectation:** recommend, close_goal. Sending the reminders again would duplicate finished work. Recording whether the goal is done adds no work and comes before starting the pricing step.
**Planner meets it:** yes

Review: useful [ ]  achievable [ ]  not_duplicate [ ]  explained [ ]  honest [ ]  workload [ ]

Notes:

## 8. already-done-only

**Situation:** Reminder work was checked done two days ago, the goal is still open, and nothing else is active.

**Recommends:** Record whether "Send invoice reminders" is done

Why, as the planner gives it:
- The goal looks done; recording that keeps your plan honest.
- Its work "Send this week's invoice reminders" was checked done on 2026-10-03, and the goal is still open.
- Serves: Send invoice reminders.
- Better than doing nothing new: it settles a goal that looks done.

Alternatives weighed:
- ranked lower: Do nothing new. Better than doing nothing new: it settles a goal that looks done.

**Proposed expectation:** recommend, close_goal. The goal looks done; recording that is the next action, not repeating the work.
**Planner meets it:** yes

Review: useful [ ]  achievable [ ]  not_duplicate [ ]  explained [ ]  honest [ ]  workload [ ]

Notes:

## 9. all-steps-complete

**Situation:** Every task under the invoice key result is complete, but the key result is still open.

**Recommends:** Record whether "Collect overdue invoices" is done

Why, as the planner gives it:
- The goal looks done; recording that keeps your plan honest.
- All 2 of its steps are complete, and the goal is still open.
- Serves: Collect overdue invoices.
- Better than doing nothing new: it settles a goal that looks done.

Alternatives weighed:
- ranked lower: Do nothing new. Better than doing nothing new: it settles a goal that looks done.

**Proposed expectation:** recommend, close_goal. The steps are done; whether the key result is met is a decision, not another task.
**Planner meets it:** yes

Review: useful [ ]  achievable [ ]  not_duplicate [ ]  explained [ ]  honest [ ]  workload [ ]

Notes:

## 10. stale-goal

**Situation:** A newsletter goal has had no progress or work for six weeks.

**Recommends:** Decide whether "Publish the monthly newsletter" is still worth pursuing

Why, as the planner gives it:
- The goal needs a decision before more work goes into it.
- Nothing has moved on it since 2026-08-24.
- Serves: Publish the monthly newsletter.
- Better than doing nothing new: it settles what further work is worth doing.

Alternatives weighed:
- ranked lower: Do nothing new. Better than doing nothing new: it settles what further work is worth doing.

**Proposed expectation:** recommend, review_goal. Six idle weeks suggest the goal no longer matters as stated; ask before adding work to it.
**Planner meets it:** yes

Review: useful [ ]  achievable [ ]  not_duplicate [ ]  explained [ ]  honest [ ]  workload [ ]

Notes:

## 11. stale-and-fresh

**Situation:** The newsletter goal is stale; a pricing goal created this week has a startable step.

**Recommends:** Start "Update pricing page"

Why, as the planner gives it:
- It is the next concrete step of an active goal, and nothing blocks it.
- Serves: Update pricing page.
- Better than doing nothing new: the day has room (0 of 5 items open).
- Ahead of the next option (Decide whether "Publish the monthly newsletter" is still worth pursuing): starting a new step comes before reviewing a goal.

Alternatives weighed:
- ranked lower: Do nothing new. Better than doing nothing new: the day has room (0 of 5 items open).
- ranked lower: Decide whether "Publish the monthly newsletter" is still worth pursuing. Ranked below: starting a new step comes before reviewing a goal.

**Proposed expectation:** recommend, start_step. Live work comes before reviewing a stale goal, and the stale goal never gets a fresh task by default.
**Planner meets it:** yes

Review: useful [ ]  achievable [ ]  not_duplicate [ ]  explained [ ]  honest [ ]  workload [ ]

Notes:

## 12. duplicate-commitment

**Situation:** The founder already committed to calling Ana about invoice 1042.

**Recommends:** Start "Update pricing page"

Why, as the planner gives it:
- It is the next concrete step of an active goal, and nothing blocks it.
- Serves: Update pricing page.
- Better than doing nothing new: the day has room (0 of 5 items open).

Alternatives weighed:
- ranked lower: Do nothing new. Better than doing nothing new: the day has room (0 of 5 items open).
- excluded: Call Ana about invoice 1042. Already committed as "call Ana about invoice 1042!".

**Proposed expectation:** recommend, start_step. Recommending the call again would duplicate an existing commitment.
**Planner meets it:** yes

Review: useful [ ]  achievable [ ]  not_duplicate [ ]  explained [ ]  honest [ ]  workload [ ]

Notes:

## 13. blocked-by-dependency

**Situation:** Sending the new price list depends on approving the new prices, which is not done.

**Recommends:** Start "Approve the new prices"

Why, as the planner gives it:
- It is the next concrete step of an active goal, and nothing blocks it.
- Serves: Approve the new prices.
- Better than doing nothing new: the day has room (0 of 5 items open).

Alternatives weighed:
- ranked lower: Do nothing new. Better than doing nothing new: the day has room (0 of 5 items open).
- excluded: Send the new price list to customers. Not now: it waits on "Approve the new prices", which is active.

**Proposed expectation:** recommend, start_step. Blocked work is not executable; the dependency is the useful next step.
**Planner meets it:** yes

Review: useful [ ]  achievable [ ]  not_duplicate [ ]  explained [ ]  honest [ ]  workload [ ]

Notes:

## 14. accepted-work-waits-on-dependency

**Situation:** Accepted work on the price-list goal is ready, but that goal waits on approving the new prices.

**Recommends:** Start "Approve the new prices"

Why, as the planner gives it:
- It is the next concrete step of an active goal, and nothing blocks it.
- Serves: Approve the new prices.
- Better than doing nothing new: the day has room (1 of 5 items open).

Alternatives weighed:
- ranked lower: Do nothing new. Better than doing nothing new: the day has room (1 of 5 items open).
- excluded: Email the price list. Not now: it waits on "Approve the new prices", which is active.

**Proposed expectation:** recommend, start_step. Accepted is not unblocked: the work waits on its goal's dependency, which is the useful step.
**Planner meets it:** yes

Review: useful [ ]  achievable [ ]  not_duplicate [ ]  explained [ ]  honest [ ]  workload [ ]

Notes:

## 15. duplicate-open-work

**Situation:** A proposal to draft the partner agreement exists without a goal link; the matching goal has no work of its own.

**Recommends:** Decide whether to do "draft the partner agreement"

Why, as the planner gives it:
- A proposal from today is waiting for your decision.
- Better than doing nothing new: it closes or moves open work.

Alternatives weighed:
- ranked lower: Do nothing new. Better than doing nothing new: it closes or moves open work.
- excluded: Draft the partner agreement. Already committed as "draft the partner agreement".

**Proposed expectation:** recommend, decide_work. The existing proposal is the step; deciding it beats creating a second copy.
**Planner meets it:** yes

Review: useful [ ]  achievable [ ]  not_duplicate [ ]  explained [ ]  honest [ ]  workload [ ]

Notes:

## 16. paused-parent

**Situation:** The only key result belongs to a paused objective.

**Recommends nothing new:** Nothing is waiting on you: 1 option is held back.

Alternatives weighed:
- excluded: Draft the partner agreement. Not now: its parent "Launch the partner program" is paused.

**Proposed expectation:** none. Paused means not now. With nothing else live, the honest answer is that nothing is waiting.
**Planner meets it:** yes

Review: useful [ ]  achievable [ ]  not_duplicate [ ]  explained [ ]  honest [ ]  workload [ ]

Notes:

## 17. full-queue

**Situation:** Five items are running, the daily limit, and a new step is available.

**Recommends nothing new:** 5 items are already open, at your limit of 5. Finish or check some before adding more.

Alternatives weighed:
- ranked lower: Start "Update pricing page". It would add work to a full day (5 of 5 items open).

**Proposed expectation:** none. Adding a sixth item to a full day is noise; the answer is to let current work finish.
**Planner meets it:** yes

Review: useful [ ]  achievable [ ]  not_duplicate [ ]  explained [ ]  honest [ ]  workload [ ]

Notes:

## 18. full-queue-still-checks

**Situation:** The day is full, but one item finished and needs checking.

**Recommends:** Check the result of "Board deck numbers"

Why, as the planner gives it:
- Its run finished, and only you can confirm the result; until then it counts for nothing.
- Better than doing nothing new: it closes or moves open work.

Alternatives weighed:
- ranked lower: Do nothing new. Better than doing nothing new: it closes or moves open work.
- ranked lower: Start "Update pricing page". It would add work to a full day (5 of 5 items open).

**Proposed expectation:** recommend, check_result. Checking reduces the load instead of adding to it.
**Planner meets it:** yes

Review: useful [ ]  achievable [ ]  not_duplicate [ ]  explained [ ]  honest [ ]  workload [ ]

Notes:

## 19. no-concrete-step

**Situation:** The objective has no tasks under it yet.

**Asks:** What is the first concrete step toward "Reach 10 paying customers"?

Alternatives weighed:
- ranked lower: Do nothing new. An answer unblocks a useful next step.

**Proposed expectation:** ask. Any concrete step would be invented; asking for the first step is more useful.
**Planner meets it:** yes

Review: useful [ ]  achievable [ ]  not_duplicate [ ]  explained [ ]  honest [ ]  workload [ ]

Notes:

## 20. last-attempt-failed

**Situation:** The last reminder attempt failed its check: three reminders bounced.

**Asks:** The last attempt at "Send invoice reminders" failed its check (Three reminders bounced). Try again as it was, or change the approach first?

Alternatives weighed:
- ranked lower: Do nothing new. An answer unblocks a useful next step.

**Proposed expectation:** ask. Repeating a failed attempt blindly wastes effort; the founder decides whether to retry or change the approach.
**Planner meets it:** yes

Review: useful [ ]  achievable [ ]  not_duplicate [ ]  explained [ ]  honest [ ]  workload [ ]

Notes:

## 21. tie-between-goals

**Situation:** Two goals with no deadlines, the same health and no order between them each have a startable step.

**Asks:** Which should come first: "Update pricing page" or "Write the onboarding email"? Nothing in their deadlines, health or order separates them.

Alternatives weighed:
- ranked lower: Do nothing new. An answer unblocks a useful next step.

**Proposed expectation:** ask. Nothing in the data separates them; picking one would be a coin flip presented as advice.
**Planner meets it:** yes

Review: useful [ ]  achievable [ ]  not_duplicate [ ]  explained [ ]  honest [ ]  workload [ ]

Notes:

## 22. deadline-breaks-tie

**Situation:** Two startable goals; one is due in three days.

**Recommends:** Start "Write the onboarding email"

Why, as the planner gives it:
- It is the next concrete step of an active goal, and nothing blocks it.
- Due 2026-10-08.
- Serves: Write the onboarding email.
- Better than doing nothing new: the day has room (0 of 5 items open).
- Ahead of the next option (Start "Update pricing page"): it has a sooner deadline.

Alternatives weighed:
- ranked lower: Do nothing new. Better than doing nothing new: the day has room (0 of 5 items open).
- ranked lower: Start "Update pricing page". Ranked below: the chosen option has a sooner deadline.

**Proposed expectation:** recommend, start_step. The deadline is the evidence that separates them.
**Planner meets it:** yes

Review: useful [ ]  achievable [ ]  not_duplicate [ ]  explained [ ]  honest [ ]  workload [ ]

Notes:

## 23. nothing-left

**Situation:** Every goal is complete and the last item is still running.

**Recommends nothing new:** Nothing is waiting on you: 1 item is running or waiting on a timer or an outside call.

Alternatives weighed:

**Proposed expectation:** none. There is nothing to add; inventing work would be noise.
**Planner meets it:** yes

Review: useful [ ]  achievable [ ]  not_duplicate [ ]  explained [ ]  honest [ ]  workload [ ]

Notes:

## 24. old-proposals

**Situation:** Proposals from earlier mornings were never decided and one was rejected. This morning a run finished.

**Recommends:** Check the result of "Send this week's invoice reminders"

Why, as the planner gives it:
- Its run finished, and only you can confirm the result; until then it counts for nothing.
- Serves: Send invoice reminders.
- Better than doing nothing new: it closes or moves open work.
- Ahead of the next option (Start "Update pricing page"): checking finished work comes before starting a new step.

Alternatives weighed:
- ranked lower: Do nothing new. Better than doing nothing new: it closes or moves open work.
- ranked lower: Start "Update pricing page". Ranked below: checking finished work comes before starting a new step.

**Proposed expectation:** recommend, check_result. Undecided proposals from earlier days are stale, as the Today view treats them; they neither crowd out new work nor fill the day.
**Planner meets it:** yes

Review: useful [ ]  achievable [ ]  not_duplicate [ ]  explained [ ]  honest [ ]  workload [ ]

Notes:

## 25. proposal-for-done-goal

**Situation:** Reminder work was checked done two days ago. This morning's fallback plan proposed working on the same goal again.

**Recommends:** Record whether "Send invoice reminders" is done

Why, as the planner gives it:
- The goal looks done; recording that keeps your plan honest.
- Its work "Send this week's invoice reminders" was checked done on 2026-10-03, and the goal is still open.
- Serves: Send invoice reminders.
- Better than doing nothing new: it settles a goal that looks done.

Alternatives weighed:
- ranked lower: Do nothing new. Better than doing nothing new: it settles a goal that looks done.
- excluded: Work on: Send invoice reminders. Its goal looks done: its work "Send this week's invoice reminders" was checked done on 2026-10-03. Record that before adding work to it.

**Proposed expectation:** recommend, close_goal. Accepting the proposal would repeat finished work. Whether the goal is done is the real decision.
**Planner meets it:** yes

Review: useful [ ]  achievable [ ]  not_duplicate [ ]  explained [ ]  honest [ ]  workload [ ]

Notes:

## 26. inherited-dependency

**Situation:** Emailing the price list, due in three days, sits under a milestone that waits on approving the new prices.

**Recommends:** Start "Review the price sheet with Ana"

Why, as the planner gives it:
- It is the next concrete step of an active goal, and nothing blocks it.
- Serves: Raise prices > Approve the new prices > Review the price sheet with Ana.
- Better than doing nothing new: the day has room (0 of 5 items open).

Alternatives weighed:
- ranked lower: Do nothing new. Better than doing nothing new: the day has room (0 of 5 items open).
- excluded: Email the price list to customers. Not now: its parent "Send the new price list" waits on "Approve the new prices", which is active.

**Proposed expectation:** recommend, start_step. A step inherits its parent's dependencies. The email cannot go out before the prices are approved, so the approval's step comes first despite the deadline.
**Planner meets it:** yes

Review: useful [ ]  achievable [ ]  not_duplicate [ ]  explained [ ]  honest [ ]  workload [ ]

Notes:

## 27. done-long-ago

**Situation:** Reminder work was checked done ten days ago; the goal is still open and nothing else is active.

**Recommends:** Record whether "Send invoice reminders" is done

Why, as the planner gives it:
- The goal looks done; recording that keeps your plan honest.
- Its work "Send this week's invoice reminders" was checked done on 2026-09-25, and the goal is still open.
- Serves: Send invoice reminders.
- Better than doing nothing new: it settles a goal that looks done.

Alternatives weighed:
- ranked lower: Do nothing new. Better than doing nothing new: it settles a goal that looks done.

**Proposed expectation:** recommend, close_goal. Finished work stays finished; a week later it must not come back as a new step.
**Planner meets it:** yes

Review: useful [ ]  achievable [ ]  not_duplicate [ ]  explained [ ]  honest [ ]  workload [ ]

Notes:

## 28. done-without-link

**Situation:** A commitment with the goal's exact title was finished three days ago, without a link to the goal.

**Recommends:** Record whether "Call Ana about invoice 1042" is done

Why, as the planner gives it:
- The goal looks done; recording that keeps your plan honest.
- "Call Ana about invoice 1042" was finished on 2026-10-02, and the goal is still open.
- Serves: Call Ana about invoice 1042.
- Better than doing nothing new: it settles a goal that looks done.

Alternatives weighed:
- ranked lower: Do nothing new. Better than doing nothing new: it settles a goal that looks done.

**Proposed expectation:** recommend, close_goal. The call already happened; the open goal needs recording, not another call.
**Planner meets it:** yes

Review: useful [ ]  achievable [ ]  not_duplicate [ ]  explained [ ]  honest [ ]  workload [ ]

Notes:

## 29. closed-in-tasks

**Situation:** Accepted reminder work was marked done in Tasks yesterday, without a result check.

**Recommends:** Record whether "Send invoice reminders" is done

Why, as the planner gives it:
- The goal looks done; recording that keeps your plan honest.
- Its work "Send this week's invoice reminders" was marked done in Tasks on 2026-10-04, and the goal is still open.
- Serves: Send invoice reminders.
- Better than doing nothing new: it settles a goal that looks done.

Alternatives weighed:
- ranked lower: Do nothing new. Better than doing nothing new: it settles a goal that looks done.

**Proposed expectation:** recommend, close_goal. Marking it done in Tasks settles it as surely as a check; asking to do it again would be wrong.
**Planner meets it:** yes

Review: useful [ ]  achievable [ ]  not_duplicate [ ]  explained [ ]  honest [ ]  workload [ ]

Notes:

## 30. timer-wait

**Situation:** A follow-up workflow is in its three-day wait. A pricing goal has a startable step.

**Recommends:** Start "Update pricing page"

Why, as the planner gives it:
- It is the next concrete step of an active goal, and nothing blocks it.
- Serves: Update pricing page.
- Better than doing nothing new: the day has room (1 of 5 items open).

Alternatives weighed:
- ranked lower: Do nothing new. Better than doing nothing new: the day has room (1 of 5 items open).

**Proposed expectation:** recommend, start_step. The wait ends by itself, so there is nothing to answer. It still counts toward the day.
**Planner meets it:** yes

Review: useful [ ]  achievable [ ]  not_duplicate [ ]  explained [ ]  honest [ ]  workload [ ]

Notes:

## 31. approval-under-paused-goal

**Situation:** A run waits for approval to send, but its goal was paused yesterday.

**Recommends:** Start "Update pricing page"

Why, as the planner gives it:
- It is the next concrete step of an active goal, and nothing blocks it.
- Serves: Update pricing page.
- Better than doing nothing new: the day has room (1 of 5 items open).

Alternatives weighed:
- ranked lower: Do nothing new. Better than doing nothing new: the day has room (1 of 5 items open).
- excluded: Send this week's invoice reminders. Not now: answering resumes it, and the goal is paused.

**Proposed expectation:** recommend, start_step. Approving would send email for a goal you paused. It waits until you resume the goal.
**Planner meets it:** yes

Review: useful [ ]  achievable [ ]  not_duplicate [ ]  explained [ ]  honest [ ]  workload [ ]

Notes:

## 32. parent-deadline

**Situation:** A task under a key result due tomorrow, and a standalone task due in five days.

**Recommends:** Start "Export the September transactions"

Why, as the planner gives it:
- It is the next concrete step of an active goal, and nothing blocks it.
- Due 2026-10-06, through "Close the Q3 books".
- Serves: Close the Q3 books > Reconcile the bank statements > Export the September transactions.
- Better than doing nothing new: the day has room (0 of 5 items open).
- Ahead of the next option (Start "Update pricing page"): it has a sooner deadline.

Alternatives weighed:
- ranked lower: Do nothing new. Better than doing nothing new: the day has room (0 of 5 items open).
- ranked lower: Start "Update pricing page". Ranked below: the chosen option has a sooner deadline.

**Proposed expectation:** recommend, start_step. A step inherits its parent's deadline; tomorrow's key result comes before a task due in five days.
**Planner meets it:** yes

Review: useful [ ]  achievable [ ]  not_duplicate [ ]  explained [ ]  honest [ ]  workload [ ]

Notes:

## 33. full-day-closes-goal

**Situation:** Five items are running, the daily limit. A goal's work was checked done yesterday, and another goal has a startable step.

**Recommends:** Record whether "Send invoice reminders" is done

Why, as the planner gives it:
- The goal looks done; recording that keeps your plan honest.
- Its work "Send this week's invoice reminders" was checked done on 2026-10-04, and the goal is still open.
- Serves: Send invoice reminders.
- Better than doing nothing new: it settles a goal that looks done.

Alternatives weighed:
- ranked lower: Do nothing new. Better than doing nothing new: it settles a goal that looks done.
- ranked lower: Start "Update pricing page". It would add work to a full day (5 of 5 items open).

**Proposed expectation:** recommend, close_goal. Recording a finished goal adds no work, so a full day does not hide it; only the new step waits.
**Planner meets it:** yes

Review: useful [ ]  achievable [ ]  not_duplicate [ ]  explained [ ]  honest [ ]  workload [ ]

Notes:

## 34. impossible-dependency

**Situation:** The launch email waits on a beta goal that was killed.

**Recommends:** Fix what "Send the launch email" waits on

Why, as the planner gives it:
- The goal needs a decision before more work goes into it.
- It cannot go ahead: it waits on "Run the private beta", which is killed.
- Serves: Send the launch email.
- Better than doing nothing new: it settles what further work is worth doing.

Alternatives weighed:
- ranked lower: Do nothing new. Better than doing nothing new: it settles what further work is worth doing.

**Proposed expectation:** recommend, review_goal. A dependency that can never finish holds the goal forever; fixing it is the useful step, not reporting that nothing is waiting.
**Planner meets it:** yes

Review: useful [ ]  achievable [ ]  not_duplicate [ ]  explained [ ]  honest [ ]  workload [ ]

Notes:

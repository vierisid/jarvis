# Workflow trigger delivery

How scheduled times, webhook deliveries, events and continuations become runs:
each one exactly once, never for a workflow that is turned off, and with a
record of what became of it.

Source: `src/workflows/runner/triggers/manager.ts` (live deliveries),
`src/lib/cron-scheduler.ts` (occurrences), `src/workflows/runner/triggers/webhook.ts`
(delivery identity), `src/workflows/runtime/continuation.ts` (resumes),
`src/workflows/db/repos/trigger-fire.ts` (the ledger) and
`src/workflows/db/repos/flow-turn-off.ts`. Tests: `delivery.test.ts`,
`continuation.test.ts`, `cron-occurrence.test.ts`.

## Owner decisions

- **Turning a workflow off stops what it started.** Its queued runs and the
  runs waiting on a timer or an approval are stopped, each saying "The
  workflow was turned off". Nothing wakes them later, and turning the workflow
  back on or publishing it does not revive them. A run executing at that
  moment is not interrupted; if it pauses, it is stopped. Runs started by hand
  after it was turned off, and test runs of a workflow that was never on, are
  not affected.
- **A missed schedule is skipped and shown.** A time that came and went while
  Jarvis was off, asleep or stalled for more than two minutes is recorded as
  missed and never run late.
- **Schedules run in Jarvis's configured time zone** (the `timezone` config
  key). A schedule that states another zone fires at that wall-clock time in
  Jarvis's zone, and the trigger list carries a warning saying so, unless it
  fires at the same moments in both zones (an hourly schedule between
  whole-hour zones). The warning compares the next firing times, now and half
  a year on, so half-hour zones and schedules tied to an hour, a day or a date
  are caught.

## Schedules

The scheduler hands each occurrence to the workflow with its wall-clock minute
in Jarvis's zone (`2026-11-01T01:30`), which is the occurrence's identity:

| Case | What happens |
| --- | --- |
| On time, or up to two minutes late | Runs; lateness over a minute shows as delayed |
| Later than two minutes (host asleep, process stalled, Jarvis off) | Recorded as missed, not run |
| A long sleep | The time still within two minutes runs; the newest 100 missed are listed, older ones counted in one row, back seven days |
| Restart within two minutes after a time | Runs, late, once |
| Autumn hour that happens twice | Its minutes fire once |
| Minute skipped by the spring-forward jump | Fires once, right after the jump, saying why |
| Restart, republish or re-enable inside the firing minute | The same occurrence is a repeat, not a second run |
| Clock stepped back | Nothing fires again; a correction of more than two minutes is logged and the schedule carries on from the new time |
| The previous time's run has not started yet | Skipped, not stacked behind it |
| Readiness broken | One failed run, then one blocked row that counts the repeats |

At startup each enabled schedule is checked for the times it was owed since it
was last watched: the newest 100 are listed as missed, older ones counted in one
row, back seven days. The watch is kept across restarts and cleared when the
workflow is turned off, switched to another trigger, or refused at
registration, so that time is never reported as missed. The live schedule
starts where the check stopped, two minutes back, so a time in between runs
late rather than being lost; one the previous process already ran is a repeat.

Editing the trigger of the draft an enabled, unpublished workflow runs replaces
its schedule. Saving a step of that draft leaves the trigger registered.

The dashboard's schedule piece (`@activepieces/piece-schedule`, run through the
engine) follows the same rules. A time it cannot run leaves a row: skipped
while its previous check is still running, blocked when the engine fails or the
workflow was turned off before its subscription was torn down.

## Webhooks

A delivery's identity, in order:

- **Unsigned workflow:** a provider delivery id header (`Idempotency-Key`,
  `X-GitHub-Delivery`, `webhook-id`, `svix-id`, `X-Shopify-Webhook-Id`), else an
  event id in the body (Stripe `evt_...`; Slack `event_id`, only inside an
  Events API callback with its `team_id` or `api_app_id`).
- **Signed workflow:** only what the signature covers: the body's event id,
  else the signature itself, for ten minutes. Headers are not signed, so a
  delivery id header is ignored there: trusting it would let a captured request
  run again under a fresh id.

A repeat answers 200 with `outcome: "duplicate"` and the original `runId`;
nothing runs again. Identical unsigned bodies without an id are separate
deliveries: pings and button presses repeat on purpose. A provider's manual
redelivery reuses its delivery id, so it answers `duplicate` too: to run the
work again, rerun it in Jarvis.

| Outcome | Reply |
| --- | --- |
| Started | 200 `{ ok, outcome: "started", fireId, runId }` |
| Repeat | 200 `{ ok, outcome: "duplicate", duplicate: true, fireId, runId }` |
| Readiness refused | 200 `{ ok, outcome: "blocked", reason }`; the delivery is kept on a failed run for a person to decide, and its retries are repeats |
| Workflow off, changed or gone | 404; a retry after it is turned back on runs |
| Queue full | 503 with `Retry-After` |
| Not recorded | 500 |

## Events

Email sync and the commitment executor announce the same thing again after a
restart. The bus gives such events a stable `_eventKey` (an email's message id;
a commitment's id, event and due time), and a workflow runs once per key. Other
events are not deduplicated. The event buffer numbers events from a per-boot
base, so a trigger cursor saved before a restart never hides new events.

## Continuations

A paused run continues once per pause. A due timer, a resolved approval and a
POST to a resume URL all claim the continuation the same way: the waitpoint is
consumed, the RESUME job queued naming it, and the continuation recorded, in
one transaction. While one continuation of a run is queued or running, another
is not queued behind it. A timer or approval whose own step already finished
is retired instead of waking the run's next pause.

A resume URL is not held to that last rule: the approval piece's Create
Approval Links step makes its URL in one step, and the run waits for it at a
later one. Each URL still continues the run once, and only while it is paused
with no other continuation queued.

The run handler checks the waitpoint again, refuses a run of a workflow turned
off since it began (and stops it), and does not continue a draft edited while
its run was paused, also when the edited draft was then published: the run
fails, saying why.

A timer or approval that comes due while Jarvis is off continues its run when
Jarvis is back, late, with the lateness recorded. Unlike a schedule, a
continuation is never skipped for being late: the run is waiting on it.

## Pause and Kill

Owner decision (Q-08, 7 October): **Pause holds, Kill stops.** The state is the
daemon's emergency controller; `runtime/emergency-hold.ts` is what workflows
read.

| While paused | What happens |
| --- | --- |
| Queued runs | Wait: the worker claims nothing; a job claimed as the pause began goes back untouched |
| A scheduled time | Skipped and recorded, keyed, so it is not run late after Resume |
| A webhook | 503 with `Retry-After`, recorded as skipped; the sender retries |
| An event source's poll | Not polled; its items are picked up after Resume |
| Timers, approvals, resume URLs | Wake nothing (a resume URL answers 503); they wait |
| A run already executing | Parks at its next Jarvis, piece or CODE step on a HOLD waitpoint, which Resume releases |
| Starting a run by hand | Refused, saying Jarvis is paused |

Kill does all of that and also stops every unfinished run (queued, executing
or waiting), saying why, and denies every pending approval; tools stop at
their next dispatch checkpoint. Reset starts nothing again.

## The ledger

`workflow_trigger_fire` keeps one row per delivery, with its source
(`schedule`, `webhook`, `event`, `poll`, `resume`, `lifecycle`), when it was
due, when it was handled, how late, its run, when that run actually began, and
why it did not start. A repeat adds no row: it is counted on the original
(`repeats`). A waitpoint is stored only as a digest: its id is a bearer
capability. Rows are pruned after 30 days; no foreign key, so the record
outlives a deleted workflow.

Read it at `GET /api/workflows/:id/fires?limit=&cursor=`, which returns
`{ fires, next }` newest first; pass `next` back as `cursor` for older rows.
Each row has a `label`: missed, blocked, skipped, stopped, delayed, or the
run's own state (queued, running, paused, completed, completed late, failed).
Delayed means the work began more than a minute after it was due: handled late,
or waiting in the queue. `GET /api/workflow-runs/:runId` includes the `fire`
that started the run, and `manage_workflow get` returns the workflow's
`recentDeliveries`.

## Limits

- Polls of event sources are not missed runs; only schedules record misses.
- A captured signed request replayed after ten minutes runs again; senders that
  need full replay protection should put a unique id in the signed body.
- A spring-forward time slept through (the host asleep across the jump) is
  neither run nor recorded.
- Events from sources other than email sync and commitments carry no key.
- Engine-managed webhooks still keep only the first item the trigger returns.
- The dashboard does not show the ledger yet; the API and chat do.

## Rollback

Revert the commits. The new table, columns and the schedule watch are additive
and ignored by older builds; deliveries then behave as before.

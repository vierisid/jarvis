# Failure messages (Q-19)

One failure reads the same everywhere it appears: a run in the Workflows room,
a reply in chat, a row in Today's "Waiting on you", a delivery toast. Every
surface shows the projection in `src/failures/projection.ts`; none classifies a
failure itself.

## The projection

`projectFailure(evidence, subject, links)` returns a `UserFailure`:

| Field | Contract |
| --- | --- |
| `category` | `invalid_input`, `missing_binding`, `provider_limit`, `target_offline`, `approval_denied`, `uncertain_effect`, `not_started`, `resource_paused`, `cancelled`, `delivery_failed` or `internal`. |
| `effect` | What took effect: `none`, `unknown` or `partial`. Never `none` without evidence that nothing did. |
| `headline`, `outcome` | One sentence each: what happened, and what did and did not take effect. |
| `next` | Safe next steps the person starts. Always ends with `open_details`. Nothing in the projection runs, retries or resends anything. |
| `links` | The run, flow, step, effect, approval, channel or chat request it is about. |
| `code` | The typed code it was classified from, or null. |
| `detail` | The original evidence with credentials redacted, bounded to 1200 characters. Shown only behind "Details". |
| `key` | Stable identity: category, code and links. Dismissals and the interruption gate use it. |

### Evidence is typed

Classification reads typed fields only, never the wording of a message:

- an action outcome's `status`, `effect` and `code` (`ActionOutcome`);
- a readiness issue's `code`;
- an `LLMErrorCode` (`LLMProviderError`, `HostedProxyError`);
- a cancellation, per-channel delivery results.

An approval decision arrives as an action outcome (`APPROVAL_DENIED` and the
like), the shape the effect boundary records.

Codes with a cause and fix of their own are named, not folded into a generic
reading:

- `background_throttled` (Jarvis's background admission budget refused the
  model call before any provider saw it) is `resource_paused`: the work was
  paused, nothing is wrong with the provider, and the wait is named when the
  error carries `retryAfterMs`. An AI step refused this way processed nothing.
- A binding pinned when the workflow was enabled that no longer holds:
  readiness `BINDING_STALE` and `WORKFLOW_MACHINE_REPLACED` ask the person to
  check the change and enable the workflow again; `WORKFLOW_FACT_STALE` and
  `WORKFLOW_FACT_AMBIGUOUS` ask them to update the recipient.
- `SIDECAR_TOO_OLD_FOR_REVIEWED_ACTION` and
  `SIDECAR_TOO_OLD_FOR_BROWSER_OUTCOMES` ask them to update Jarvis on that computer.
- `EMERGENCY_STOPPED` (Kill) says to run it again once Jarvis is running again.

`failureEvidence(error)` maps a thrown error to evidence by its type. An error
with no typed shape is `unknown`: its text is kept as detail, and for work that
can change things outside Jarvis it reads as "may have taken effect".

`src/failures/fixtures.ts` holds one canonical failure per category and the
timeouts that must never read as "nothing happened".

## Delivery

`src/comms/delivery.ts` classifies a failed send from its error's name, runtime
code, HTTP status and unsent remainder:

| Failure | Reading | Retried |
| --- | --- | --- |
| Refused before sending (`NotSentError`), 4xx, a named wait | not sent | 429 and named waits only |
| Connection never made (`ECONNREFUSED`, `ENOTFOUND`, ...) | not sent | yes |
| Timeout, dropped connection, 5xx, part of a long message sent, untyped | may have arrived | never |

Discord's own client retries are off (`rest: { retries: 0 }`): discord.js would
otherwise resend a timed-out or 5xx request up to three times. A desktop toast
has three receipts: shown, not shown, or unknown when the sender ran past its
five-second wait (the toast may already be up), which reads as may have arrived.

A send that may have arrived is reported as unconfirmed, never as "not sent",
and is never retried or replaced by a fallback: the opportunity outbox records
`unconfirmed_at` and stops; nothing falls back to a critical desktop alert.

If an earlier chunk was sent but the next chunk was explicitly refused (for
example with HTTP 429), only the raw unsent remainder may be retried. An uncertain
chunk is never retried. Literal Discord text keeps its escaping, disabled mentions
and suppressed previews on every attempt; retries do not repeat the sent prefix.
Main's approved-recipient check still runs immediately before workflow delivery.

The workflow notify step reports `delivered`, `failed` and `unknown` for each
channel. It fails, with `DELIVERY_FAILED`, only when nothing was sent anywhere,
and the failed reply still carries each channel's report. A channel that may
have taken the message counts as sent. The dashboard, voice and desktop count
as delivered only when something accepted it.

Behavior change for existing workflows: with no dashboard open, a dashboard
that `auto` chose is skipped like an unconnected channel and the desktop shows
the message instead. The choice is frozen with the step's reviewed arguments
(`autoDashboard`, `fallback: "desktop"`), so an approval covers it. A step that
names `dashboard` itself fails when none is open; before Q-19 it counted as
delivered with nobody watching.

## Runs

`runFailure(run)` derives a failed run's failure on read from the run row and
its effect records. It is never stored. CODE steps and Library pieces reach the
outside world without an effect record, so what the rest of the run did is read
from the records and from the run's step trace. A run that left no trace (an
engine failure, a production run that does not stream progress) may have run
any untracked step ahead of the failure, or in the same loop. Then the reading
never says nothing was done, and it never offers a plain "run it again", which
would repeat those steps: it says to check what the earlier steps did. A resume
refused because the workflow changed reads the same way about the steps before
the pause. The workflow effect boundary records
refusals decided before dispatch as typed outcomes: `APPROVAL_DENIED`,
`APPROVAL_EXPIRED`, `APPROVAL_WITHDRAWN`, `APPROVAL_REQUIRED`,
`AUTHORITY_DENIED`, `EMERGENCY_STOPPED`, `RUN_NOT_RUNNING`, `WORKFLOW_CHANGED`.
These governance refusals are never a handled outcome, even for a probe step.
An AI step keeps its provider's code as `PROVIDER_<CODE>`. Run list and run
detail responses carry `failure`. Run lists retain main's `{ items, nextOffset }`
pagination envelope, with the failure on each item. An approved card whose action
is later blocked or fails still receives main's terminal receipt alongside the
typed failure evidence.

## Chat

A failed turn's error frame carries `failure`, a typed `code` and a redacted
`message`; protocol errors (a chat message with no text, an unknown command)
keep their own wording. A turn that had already called a tool that can change
something (any call Authority does not judge as purely reading) never reads as
"nothing was done". The relay broadcasts a turn's error to every tab; only the
tab that asked reacts with voice or turn state. An error the handler returns
goes to the asking socket alone. A failed task records the same sentence. A
reply that was shown but could not be saved reads as that, never as a failed
request.

## Today

`GET /api/failures/open` lists, newest first, at most 20 rows. Each stays until
resolved or dismissed (owner decision); nothing ages out.

- runs that ended badly. A failure that changed nothing clears when a later
  run of the same workflow succeeds. One that may have taken effect stays
  until its recovery is inspected (Q-07). A run stopped with nothing in flight
  is not listed. Repeats of the same failure share one row, so one workflow
  failing all day cannot push the others out;
- notify steps a channel did not confirm;
- chat turns that failed after they may have acted (`chat_failure`).

Runs are indexed as they finish into `open_failure`, by a cursor over
`flow_run.updated` (indexed). A poll reads what finished since the last one and
what is still open, never the history; a row leaves the index once it is
settled. The very first scan looks back one week.

`POST /api/failures/dismiss` with `{ "keys": [...] }` dismisses rows
(`failure_dismissal`, kept 90 days; a dismissed chat failure is deleted).
"Waiting on you" shows each row with the same sentence, counts it, stays pinned
while any wait, and its Open lands on the run itself.

Workflow and notify-delivery rows are scoped by the owning flow's project before
the query limits. The dismissal endpoint accepts only keys in the selected
project's current inbox, so a known foreign key cannot hide another project's
failure. Invalid or no-longer-visible keys are ignored. Chat failures retain their
existing account-wide conversation scope. A dismissal never queues or retries work.

## Interruptions

`InterruptionGate` allows one urgent alert per issue per hour; later alerts
about the same issue reach the dashboard quietly. `ScreenAlerts` routes the
alerts about one on-screen error or struggle (`screenIssueKey`): while research
into it is under way, the heads-up goes to the dashboard quietly and claims
nothing, and the researched fix is the one interruption (owner decision). With
no research, the heads-up may interrupt. If research finds nothing, nothing
interrupts. The gate is in memory: after a restart an issue may interrupt once
more, never less.

## Known limits

- `src/llm` still derives some `LLMErrorCode` values from provider error text
  before Q-19 reads them. Typing those at the source changes retry and failover
  behavior and needs its own change.
- A chat failure that changed nothing is not kept for Today; chat already
  showed it.
- If Kill or an Authority change refused every channel of a notify step, the
  step would read `DELIVERY_FAILED` rather than the refusal. It does not happen
  in practice: the first channel is checked in the same tick as the dispatch
  claim, which has just passed the same checks.

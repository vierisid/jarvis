# Authority across every execution entry

Every way Jarvis can act passes the same Authority checks, whichever surface
starts it: no route runs a governed action without approval, an approval never
covers different arguments, two surfaces deciding one request produce one
dispatch, and Pause and Kill hold below every UI control (Q-08).

Tests: `src/authority/entry-matrix.test.ts` (chat, voice, realtime, channels,
toasts, the executor), `src/workflows/runtime/emergency-hold.test.ts`
(workflows under Pause and Kill), and the existing Authority suites they sit
beside (`workflow-authority.test.ts`, `governed-pieces.test.ts`,
`approval-receipts.test.ts`, `browser-intent.test.ts`).

## Owner decisions (7 October)

- **Voice leaves a card.** In a live voice conversation, an action that needs
  approval is not run. It leaves an approval card on the dashboard and in chat,
  and Jarvis says so. Until now realtime voice auto-approved it.
- **Voice may keep pressing dashboard buttons** (grant access, run a workflow,
  start an agent, restart Jarvis) as it does today. Recorded as a known path:
  those buttons act as a click would.
- **Pause holds, Kill stops** (below).
- **Approving from chat** needs a sender on that channel's allowed users list
  and the 8-character id from the card. With no list set, chat can deny but not
  approve.

Defaults: a chat or background card nobody answers expires after 24 hours
(workflow approvals keep their own lifecycle); community pieces and CODE steps
stay opt-in, without per-run approval, but obey Pause and Kill and are audited.

## The matrix

| Entry | Checked when it starts | When an approval runs | Pause | Kill |
| --- | --- | --- | --- | --- |
| Chat tool call (main agent) | Authority per category, profile, taint | Permissions judged again as the same agent; arguments, intent and UI subject as stored | Refused | Refused; a tool in flight stops at its next checkpoint |
| Background agent | Same, with its level cap | Same, cap included | Refused | Refused |
| Chat sub-agent | Same, with the parent's profile | No approvals outside workflows | Refused | Refused |
| Approval from the dashboard | Compare-and-set decision, then one claim | As above | Approving waits for Resume (refused, saying so); denying works | Pending cards are denied |
| Approval from Telegram or Discord | Allowed sender, exact card id, card shown whole | As above; click-only cards refused | Approving waits for Resume | Pending cards are denied |
| Approval from a toast | Card shown whole; click-only cards refused | As above | Approving waits for Resume | Pending cards are denied |
| Spoken yes or no | Only with exactly one card waiting; not destructive or click-only | As above | Approving waits for Resume | Pending cards are denied |
| Realtime voice | Authority per category; approval leaves a card | Card runs like any other | Refused | Refused |
| A denied `request_approval` | The category needs its own approval for the rest of the turn | | | |
| Manual Run, `manage_workflow` run, work item | Readiness, CODE grant (work items too) | | Refused, saying why | Refused |
| Schedule, webhook, event, poll | Admission, readiness | | Skipped and shown; webhook 503; poll waits | Same |
| Timer, approval, resume URL | One continuation per pause | | Wait (resume URL 503) | Runs stopped |
| Governed workflow step (Jarvis pieces, verified pieces, child workflow, delegated agent) | Authority as the workflow or its delegate | Version digest, full-input digest, permissions, approval, emergency, all again before the claim | Parks on a HOLD waitpoint | Blocked; the run is stopped |
| Community piece, CODE step | Opt-in (Library install, per-workflow CODE grant) | | Parks on a HOLD waitpoint | Does not run |
| Raw UI and desktop actions | Mandatory dashboard review | Click on the dashboard only | Refused | Refused |

## What an approval binds

- **Arguments.** Chat runs the stored arguments; a UI call also its captured
  subject; a card that carried a sentence must still produce the same one.
  Workflow effects are bound by a digest of the request and of the version;
  for a piece that includes a digest of its whole resolved input, not only the
  shortened copy the card shows (a body past 512 characters, a list past 25
  items).
- **Permissions.** Each request records whom it was asked for (role, level,
  profile). When it runs, the same checks are made again as that agent: a deny
  override, a context rule or a revoked permission added since the card was
  raised stops it. A request from before this recorded no one and is asked for
  again.
- **Who decided.** A card whose effect must be reviewed on screen is approved
  on the dashboard only; every other surface refuses it, and the executor
  refuses an approval from anywhere else.
- **One dispatch.** The decision is a compare-and-set and execution takes one
  claim, so two surfaces deciding at once run it once.

## Pause and Kill

Pause holds. Nothing new starts or continues: agents' tools are refused,
approving a card waits for Resume (denying works), the workflow worker claims
nothing, triggers start nothing (a scheduled time is
skipped and shown, a webhook is told to retry, a poll waits), timers,
approvals and resume URLs wake nothing, and manual starts are refused. A
workflow already executing parks at its next step on a HOLD waitpoint, which
Resume releases. Work in flight finishes.

Kill stops. On top of the hold, every unfinished workflow run is stopped,
saying why, every pending approval is denied, and a tool in flight stops at
its next dispatch checkpoint. Reset starts nothing again.

The controller is the one source of truth: the engine's copy of the state is
updated on every change, and accepting a learning suggestion no longer writes
it back, so a Kill survives a restart.

## Outcomes stay distinct

An approved request ends as one of: executed (`committed`), failed, blocked
(nothing ran: refused, emergency, permissions), or unknown (the tool could not
say whether it took effect; never run again, closed by a person). The chat
reply, the dashboard notification, the tray's recent actions and the "Task
complete" toast say which, instead of "executed" for all of them. Every
decision is audited with its surface, and every receipt with its outcome.

## Limits

- Voice can still press dashboard buttons that change permissions or start
  work (owner decision).
- Community pieces run with Jarvis's own permissions and can read any saved
  connection: the Library's opt-in trust model, not changed here.
- A delegated agent's allowed calls are checked but not listed as run effects
  (Q-10).
- Approval cards show what will happen, not the raw arguments.
- Kill stops a tool at its next dispatch checkpoint: one command already
  running on a machine finishes. A sub-agent's model loop is not aborted; its
  tool calls are refused.
- An intent grant (`request_approval`) is recorded as executed.
- Opportunity activation has no route of its own; accepted work items start
  through the run route.

## Rollback

Revert the Q-08 commits. The new column (`approval_requests.principal`) and
waitpoint type (`HOLD`) are additive. Rows asked for after the upgrade carry a
principal older builds ignore; a HOLD waitpoint left by a paused run is not
released by an older build, so resume Jarvis before rolling back.

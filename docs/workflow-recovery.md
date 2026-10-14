# Recovery of uncertain workflow execution (Q-07)

A failed or interrupted run is never automatically replayed. `RUN_FLOW` still
has one attempt. A recovery decision does not enqueue, resume, change Authority,
reuse an approval, or declare a business outcome achieved.

## Execution and receipt boundary

Four actions use a completion protocol in addition to the existing Authority
boundary: Gmail `send_email` / `gmail_send_email`, and Slack
`send_channel_message` / `slack_post_message`. Identity is the existing tuple
(run, step, loop path, route), with route `piece-dispatch`. The whole input digest
and pinned graph bind its approval. A connection-token digest also binds these
approvals to the OAuth credential resolved by the engine; the token is not saved.

The daemon claims the dispatch before returning permission to the engine. A
second authorize cannot cross that fence while the outcome is unknown. A success
POST saves the result before the engine continues; if only that POST's response
is lost, the next authorization returns the saved result without calling the
provider again. A crashed or disconnected dispatch stays uncertain, including a
crash between permission and the provider call. Generic exceptions after direct
dispatch are also unknown. Secondary audit failures cannot overwrite a saved
success. Completion after Kill records evidence and never revives the run.

Gmail 0.17's Gaxios response keeps its `data`, `status`, and `statusText` envelope;
transport configuration/headers are removed before persistence and engine output
because they can contain credentials. Slack returns its API result. Receipts are
bounded to 256 KiB; an oversized/missing receipt leaves dispatch uncertain.

An existing legacy `piece` authorization for any of these send actions fails
closed after upgrade. It may already have sent; it must not acquire a new
`piece-dispatch` identity. New engines also refuse a daemon without the completion
protocol. Rebuild the engine with the daemon; mixed/old engines are not certified.

Q-08's emergency holds preserve the original execution type and resume payload.
A parked step does not enter the completion protocol until execution is admitted.
Pause/Resume therefore keeps its timing and payload, while the dispatch fence
prevents a resumed selected send from being sent twice.

## Shared read contract and decisions

`GET /api/workflow-runs/:runId` and `/effects` include `recovery`.
`GET /api/workflow-runs/:runId/recovery` returns `{ recovery }`.
Work items include the same additive `recovery` member. Healthy/nonterminal runs
return `null`; terminal incomplete runs return:

- `state`: `unknown`, `blocked` (recorded effects did not dispatch), or
  `recoverable` (partial completion evidence exists, still no replay).
- `effects`: stable effect/step IDs, `unknown` / `not_started` / `completed`,
  lookup capability and qualified provider evidence. A legacy authorization is
  never presented as a completed external effect.
- `untrackedSteps`: failed or interrupted steps without a matching effect
  record, including their loop path when retained evidence identifies it
  (`null` means the path is unknown). These keep the run `unknown` even when
  other effects completed. Status-less partial progress is not completion proof.
- `needsAttention`, a revision bound to the actual evidence and last decision,
  immutable receipt history, `canReplay: false`, and `newRunRequired: true`.

`GET /api/workflow-recovery?limit=50&cursor=…` is the additive Needs you inbox.
Follow `next` even on an empty filtered page. Acknowledged rows are filtered, but
pagination advances over the underlying runs. This does not activate Brief or
implement its UI. F-21 should consume/re-export these shapes and must not add a
second reconciliation writer.

Recovery lists, reads and decisions are scoped to the selected project through
the workflow that owns the run. Filtering happens before pagination; another
project's run cannot consume a page, expose a receipt or accept a decision.
A foreign or deleted workflow/run returns 404, including repeated request IDs.

`POST /api/workflow-runs/:runId/recovery` accepts exactly one of:

```json
{"requestId":"unique-user-choice-1","revision":"<displayed SHA-256>","action":"reconcile","effectId":"wfe_<SHA-256>"}
```

```json
{"requestId":"unique-user-choice-2","revision":"<displayed SHA-256>","action":"inspect","note":"What I inspected and what remains uncertain"}
```

Reconcile performs a read-only lookup under current read Authority and emergency
state. An unavailable authority service, approval-requiring read, Pause or Kill
blocks lookup. Inspect records the user's bounded note and acknowledges the
current evidence; it does not turn an unknown outcome into success or no-effect.
A late receipt invalidates that acknowledgement. Normal manual Run remains the
only path to a new intentional run and all its readiness/approval guards apply.

A successful typed completion receipt remains `completed` when its mode has no
readback adapter, including Slack user-mode sends and threaded messages.
`lookupSupported` describes only the ability to perform another provider lookup;
it does not qualify an already saved completion. Malformed receipts stay unknown.
For reconciliation, a confirmation is bound to the effect identity, request,
version, connection binding and exact provider receipt. Later inconclusive or
blocked lookups and unrelated run progress cannot erase that historical fact.
`providerEvidence` retains the confirmation; all subsequent attempts remain in
`receipts`. A different provider receipt cannot reuse it. Older recovery receipts
without that binding remain usable only for their original evidence snapshot.

The append-only `workflow_recovery_receipt` is the authoritative recovery audit:
actor, choice, run/flow/version/effect IDs, evidence digest, time and result are
committed together. A repeated request ID with identical content returns the
same receipt; changed content conflicts. Concurrent choices and stale evidence
cannot overwrite each other. A crash during lookup permits another read, never
a send. Receipts survive deletion of the run for audit; deleted run views remain
404. These routes inherit the authenticated daemon API boundary, not engine or
public webhook access.

## Exact reconciliation coverage

Provider read-back is intentionally narrower than completion tracking:

| Connector | Supported receipt lookup |
| --- | --- |
| Gmail 0.17.0 send aliases | Exact message ID in the saved send result (`data.id` or direct `id`); GET message with `format=minimal`, matching ID and SENT label |
| Slack 0.21.0 send aliases | Exact channel + timestamp from a successful post; GET conversations.history with identical oldest/latest timestamp; native OAuth bot mode, top-level messages, no file upload |

Both require the listed exact connector version, a literal native `OAUTH2`
connection binding pinned at dispatch and the same
project, piece, connection row and credential digest at lookup. Managed Google,
custom/dynamic credentials, rotated tokens, Slack user-token mode, threaded
replies and file uploads have no read-back adapter in this card. A token refresh
is conservatively a changed credential, not permission to search another account.

A top-level succeeded run-step output can supply a missing direct receipt, but
only exact provider read-back can reconcile that uncertain dispatch; the stored
dispatch fence stays closed. Loop receipts must have been saved directly with
the exact execution path. No subject/body search is used as an idempotency key.

Missing IDs, 404s, deletions, permissions, rate limits, timeouts, malformed or
oversized responses remain inconclusive/unknown. Unsupported tools, desktop/UI,
CODE, delegates and other community actions require inspection. Confirmation
establishes presence of that provider message, not recipient delivery/read,
completion of remaining steps, goal progress, or permission to send again.
There is no general exactly-once claim and provider-internal SDK/network retries
are outside the Jarvis redispatch guarantee. Verification uses fake providers;
live providers and paid models are not run.

Provider semantics: [Gmail messages.get](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get)
and [Slack conversations.history](https://docs.slack.dev/reference/methods/conversations.history/).
The installed npm bundles for Gmail 0.17.0 and Slack 0.21.0 were inspected for
return envelopes and token selection; they are not copied into this repository.

## Stack integration and rollback

Q-07 was rebased on 2026-10-14 onto Q-08 #891 at
`5353482f02f2c9d555cae6553519e4e5cddcfe16`, which includes Q-06 #806 and main
`5024ea7455a5613be0514475be32c0dee6de0edd`. This retains the existing stack
order and adds no product prerequisite. The PR remains unmerged.

Keep current main's stricter channel allowlists for approve **and deny**, exact
short-ID matching, review-only delivery restrictions, ApprovalGuard and argument /
version checks when integrating Q-08. Q-07 does not replace those files or
introduce an approval/execute endpoint. Preserve Q-08's Pause/Kill and approval
revalidation around this completion protocol. Main + the full F stack are not
certified by this stacked PR's tests. F-21 overlaps API projections only; recovery
writes stay in this module.

Rollback by reverting Q-07 and rebuilding the daemon/engine together. Retain the
additive table and effect records for audit. Before running an older binary,
stop/drain workers and do not resume any run with `piece-dispatch` records: an old
engine knows only authorization records and cannot enforce this completion fence.
Inspect those runs and use a new intentional run if appropriate. No migration
rewrites unknown records into pending or successful ones.

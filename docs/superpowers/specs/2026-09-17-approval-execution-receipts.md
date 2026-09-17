# A4: approvals carry an execution claim and a receipt

## Contract

An approval's decision and its execution are separate writes. The claim
records that one executor took the approved request before dispatch; the
receipt records what that execution produced. After a restart, an approved
row without a receipt is reconciled and shown to the user, never rerun.

| Row | `status` | `execution_outcome` | Meaning | User actions |
| --- | --- | --- | --- | --- |
| Awaiting a decision | `pending` | null | Not decided | approve, deny |
| Awaiting execution | `approved` | null, unclaimed | Decided this boot; an executor has not taken it yet | none |
| In flight | `approved` | null, claimed this boot | An executor holds it | none |
| Not started | `approved` | `not_started` | Approved before a restart, never claimed. Nothing happened | execute once, close |
| Interrupted | `approved` | `unknown` | Claimed by a previous process, no receipt. The effect may have happened | close |
| Closed | `approved` | `closed` | Resolved by the user without running | none |
| Receipt | `executed` | `committed`, `failed` or `blocked` | The tool returned, threw, or was refused under emergency state | none |

`executionState(row)` names the stage in one word and rides on every
approval the API returns as `execution_state`.

Routes: `GET /api/authority/approvals?status=unresolved` lists the not
started and interrupted rows; `GET /api/authority/status` reports them as
`unresolved_approvals` beside `pending_approvals`; the tray badge counts
both. `POST /api/authority/approvals/:id/execute` runs a not-started row
once and answers 409 for an interrupted row or an intent grant; `POST
/api/authority/approvals/:id/close` resolves either, with an optional
`note`. Both answer 404 for a row that is not awaiting a decision. The
Authority room shows unresolved rows in their own section with those two
actions. Approve and deny keep answering 404 for them: the decision was
already made.

## Invariants this protects

- One execution per approval. `claimExecution` is a conditional update on
  an approved, unclaimed row, so two surfaces resolving the same approval
  at once run it once; the loser learns the row's state and does nothing.
  `DeferredExecutor.executeApproved` claims before it checks emergency state
  or touches the tool registry, and the inline gate, voice, notifications,
  channels and the dashboard all run through it.
- A restart never executes anything. `reconcileAfterRestart` runs once
  before the daemon serves and only writes states. A row claimed under
  another boot id becomes `unknown` and can never be claimed again, so the
  only way forward is a person checking what happened and closing it. A row
  never claimed becomes `not_started`; running it is an explicit second
  decision that goes through the same claim.
- A receipt is written only on an approved row, once. Each receipt names its
  outcome: `committed` when the tool returned, `failed` when it threw (a
  partial effect is possible), `blocked` when emergency state refused it.
- Rows the running process holds are left alone. Reconciliation compares
  the claim's boot id with its own, so an in-flight approval on a daemon
  that reconciles late is not mislabelled.
- Workflow-owned approvals are excluded from reconciliation and from the
  unresolved list. Their truth is the `workflow_effect` record, which has
  its own claim, receipt and replay refusal.
- The status column keeps its five values. A closed row stays `approved`,
  which is what the user decided; the outcome and `resolved_by` say the
  execution was closed. Old rows read as unclaimed, so a database written
  before this change reconciles the same way.

## What this does not do

- It does not reconcile inside a running process. An approved row whose
  executor died without a crash (an unhandled error between the flip and
  the claim) stays awaiting execution until the next restart.
- It does not write a receipt for a workflow effect that failed. That row
  stays `approved` with the effect record as its receipt.
- It does not learn from resolutions. Running a not-started row once is
  not counted toward auto-approve suggestions beyond what the executor
  already records.
- Channels and notifications do not offer execute and close yet; the
  dashboard and the API do.

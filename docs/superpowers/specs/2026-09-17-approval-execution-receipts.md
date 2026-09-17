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
| Closed | `approved` | `closed` | Resolved without running, by the user or by the migration | none |
| Receipt | `executed` | `committed`, `failed` or `blocked` | The tool returned, threw, or was refused under emergency state | none |

`executionState(row)` names the stage in one word and rides on every
approval the API returns as `execution_state`.

Routes: `GET /api/authority/approvals?status=unresolved` lists the not
started and interrupted rows; `GET /api/authority/status` reports them as
`unresolved_approvals` beside `pending_approvals`; the tray badge, the
Authority room's Pending count and its tab badge count both. `POST
/api/authority/approvals/:id/execute` runs a not-started row once. It
answers 409 for an interrupted row, for an intent grant, and when another
surface took the claim between the check and the run; that last case is
never reported as a run. `POST /api/authority/approvals/:id/close`
resolves either kind, with an optional string `note`; a missing or
non-object body means no note. Both answer 404 for a row that a restart
did not leave unresolved. The Authority room shows unresolved rows in
their own section with those two actions and keeps them out of the recent
decisions list. Approve and deny keep answering 404 for them: the decision
was already made.

## Invariants this protects

- One execution per approval. `claimExecution` is a conditional update on
  an approved, unclaimed row, the same CAS shape as `claimWorkflowEffect`,
  so two surfaces resolving the same approval at once run it once; the loser
  learns the row's state and does nothing. `DeferredExecutor` claims before
  it checks emergency state and before it dispatches, and the inline gate,
  voice, notifications, channels and the dashboard all run through it.
- A restart never executes anything. `reconcileAfterRestart` runs once
  before the daemon serves and only writes states. A row claimed under
  another boot id becomes `unknown` and can never be claimed again, so the
  only way forward is a person checking what happened and closing it. A row
  never claimed becomes `not_started`; running it is an explicit second
  decision that goes through the same claim.
- Rows approved before this change are closed by the migration, once, with
  `resolved_by = 'migration'`. The old code wrote no claim, so whether any
  of them ran is unknowable, and the first boot after the upgrade must not
  offer to run months-old arguments. Only rows approved from then on are
  reconciled at startup. Pending rows are not touched: the closure matches
  `status = 'approved'`, so a decision the user has not made yet is still
  theirs to make, and a closed row is unclaimable, so nothing it authorized
  can run unreviewed.
- The column additions and that closure are one transaction. They are
  separate writes and SQLite rolls DDL back with the rest of a transaction,
  so the marker for "already migrated" (the columns existing) cannot
  outlive the closure. A crash between them would otherwise leave the next
  boot reconciling every pre-upgrade approved row to `not_started` and the
  dashboard offering to run months-old arguments. The process that performs
  the closure warns once on stderr with the count, so it is not an
  invisible state change.
- A receipt is written only on an approved row, once. Each receipt names its
  outcome: `committed` when the tool returned, `failed` when it threw (a
  partial effect is possible), `blocked` when emergency state refused it.
- Rows the running process holds are left alone. One boot id per process,
  shared by every manager in it, and reconciliation compares a claim's boot
  id with its own, so an in-flight approval on a daemon that reconciles
  late is not mislabelled. Reconciliation is idempotent: a second run
  changes nothing.
- Workflow-owned approvals are excluded from reconciliation, from the
  migration closure and from the unresolved list. Their truth is the
  `workflow_effect` record, which has its own CAS claim, recorded outcome
  and replay refusal. That outcome is not the same kind of receipt: for a
  governed piece the HTTPS call happens in the engine subprocess after the
  daemon authorizes it, so the effect record is a dispatch authorization,
  not a delivery receipt (docs/WORKFLOW_AUTOMATION.md). The receipts here
  cover the approvals the daemon itself dispatches, where the tool returns
  in process before the receipt is written.
- The status column keeps its five values. A closed row stays `approved`,
  which is what the user decided; the outcome and `resolved_by` say the
  execution was closed. Old rows read as unclaimed, so a database written
  before this change reconciles the same way.

## What this does not do

- It does not reconcile inside a running process. An approved row whose
  executor died without a crash (an unhandled error between the flip and
  the claim) stays awaiting execution until the next restart.
- Not-started rows do not expire. `expireOld` only ages pending rows and
  has no production caller; a not-started row from a restart weeks ago is
  still runnable, with its decision date on the card.
- It does not write a receipt for a workflow effect that failed. That row
  stays `approved` with the effect record as its receipt.
- Rows executed before this change carry no outcome and read as
  `committed`, including ones whose result text records a tool error. The
  text is not inspected to guess.
- An intent grant's receipt reads `committed`; nothing was dispatched, the
  grant itself is what completed.
- It does not learn from resolutions. Running a not-started row once is
  not counted toward auto-approve suggestions beyond what the executor
  already records.
- The dashboard closes without a note; only the API takes one, and no
  surface renders `resolution_note` back. Channels and notifications do not
  offer execute and close, and nobody is told at boot that unresolved rows
  exist beyond the counts. The migration's closure is announced once on
  stderr and otherwise reads as a `closed` chip in recent decisions.
- It does not unblock a commitment that was waiting on such an approval.
  `CommitmentExecutor` counts an `approved` row as still pending, and a
  reconciled or closed row stays `approved`, so the commitment keeps
  waiting exactly as it did before this change.
- A lost claim is reported accurately only on the execute route, which
  answers 409. `applyApprovalDecision` still reports its own dispatch as
  executed and passes the executor's refusal text through as the result.
  Approve is a CAS on a pending row, so only one surface reaches the
  executor from there, which is why the branch is unreachable in practice.

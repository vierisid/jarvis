# Today work-item contract

Today reads `GET /api/work-items?today=true`. This returns all work proposed on the
server's current local calendar day, including rejected, blocked and checked work.
`planId` and `goalId` filters can also be supplied. `GET /api/work-items/:id` returns
the same record, including live run state, after a restart.

## IDs and ownership

`WorkItem` is exported from `src/goals/work-items.ts`. Its `id` is an existing
commitment ID. `commitment_work` extends that record with:

| Field | Contract |
| --- | --- |
| `planId`, `actionIndex` | Morning check-in ID and zero-based action position. Unique together. |
| `goalId` | Goal ID, or null when the source supplied no valid goal. Never inferred from a title. |
| `mode` | `manual` or `workflow`. Morning proposals start as manual work. |
| `workflowId`, `workflowVersionId` | Existing flow ID and immutable, locked version ID. Both null for manual work. |
| `input` | Workflow trigger payload, frozen with the accepted proposal. |
| `decision` | Persisted ID, accepted/rejected outcome, reason, user attribution and timestamp. |
| `runId`, `run` | Existing production run ID and its live record. Never substituted with the latest run of a workflow. |
| `blocker` | Typed reason and source reference: manual, waitpoint, missing_run, run_failure or result_check. |
| `resultCheck` | Persisted check ID, passed/failed verdict, summary, evidence references, user attribution, timestamp, run snapshot and optional goal progress ID. |

All new IDs are opaque strings. Existing check-in text remains `actions_planned`;
`work_item_ids` lists its work IDs in action order. Morning results additionally
return `workItems`. Legacy LLM string actions are supported and keep `goalId: null`.
On upgrade, existing text-only morning plans gain work records once, preserving
their original date and action positions. No historic text is silently assigned
to a goal or marked completed. `/api/goals/daily-actions` retains
its legacy active goal-row response for existing clients and independent rhythms.

## Writes

1. Morning planning creates check-in, commitments and relations atomically.
   Alternatively `POST /api/work-items` with `{title, goalId?, mode?, workflowId?,
   workflowVersionId?, input?}` creates a proposal. Default mode is manual.
2. `PATCH /api/work-items/:id` changes `goalId`, `mode`, `workflowId`,
   `workflowVersionId` or `input` before a decision. Workflow versions must belong
   to the selected flow and be locked. Clear both workflow IDs when switching to manual.
3. `POST /api/work-items/:id/decision` with `{outcome: "accepted" | "rejected",
   reason}` records the user's choice and freezes configuration. Exact retries
   return the original decision. Changing decided work requires a new proposal.
4. `POST /api/workflows/:workflowId/run` with **only** `{workItemId}` starts
   accepted workflow work. It uses the frozen version and input, even after a
   newer version is published. The run, queue job and relation commit in one
   transaction. Repeated requests return the original run and never enqueue a
   second execution. A deliberate rerun requires a new proposal. Run `triggeredBy`
   includes both work and decision IDs for reverse navigation.
5. `POST /api/work-items/:id/blocker` with `{reason}` blocks accepted unstarted
   work; `{reason: null}` clears it. Running work derives blockers from the run
   and existing waitpoints. Resume/approval remains the existing runtime contract.
6. `POST /api/work-items/:id/result` with `{verdict: "passed" | "failed", summary,
   evidence: [{ref, description}], goalScore?}` records an explicit user check.
   At least one evidence reference is required. Workflow work needs its finished
   linked run; only SUCCEEDED runs can pass. A passed check may set an absolute
   goal score in [0,1], producing a goal progress entry linked back to the check.
   Check, progress and commitment completion commit atomically. A second check
   returns 409; retrieve the existing result after an uncertain HTTP response.

Due dates on linked commitments are metadata. Legacy commitment scheduling,
automatic due events and reminder context exclude linked work, regardless of its
decision or mode. Workflow work starts through the linked run endpoint; manual
work is carried out by the user and requires an explicit result check.

These routes use the daemon's existing authenticated API boundary. A planning
decision records intent; it does not grant tool authority or resolve runtime
approval requests. Evidence references are supplied by the user and are not
automatically fetched or independently verified by an LLM.

## Reading outcomes

`status` is proposed, rejected, ready, running, blocked, needs_check, verified or
failed. SUCCEEDED alone means `needs_check`, not verified goal progress. A manual
commitment marked completed through an older client also remains unchecked.
An explicit result check is the authority for `verified`. Checks retain the run
snapshot if run history is later deleted; an unchecked missing run is blocked.
An unresolved waitpoint blocks result checking when the run is still active or
an older runtime incorrectly recorded SUCCEEDED. Terminal failures take precedence
over leftover waitpoints and can receive a failed-result check, never a passed
check or goal progress. A pause finishes the current queue job while keeping the run PAUSED
with no finish time; the existing resume endpoint continues the same run.
At startup, an interrupted execution that exhausted its attempts is recorded as
FAILED with its partial outputs and an unknown-outcome explanation. It is never
silently replayed. Inspect those outputs before recording a failed check or
creating a new proposal. Recovery preserves terminal results and pending pauses;
an exhausted resume with no remaining waitpoint is also recorded as a failure.
Cancelling an unclaimed execution or resume records STOPPED atomically with the
queue cancellation. Its original run ID and any partial outputs remain available
for a failed-result check. Startup also repairs cancelled jobs left unfinished
by older code, preserving terminal outcomes and later attempts. An already
running executor remains responsible for reporting its actual outcome.
Evening review receives these linked decisions/results and is instructed not to
count an already recorded goal progress entry again. Its independent goal review
behavior is preserved; LLM narration never writes work-item verification.

The schema is additive and installed by vault initialization, so goal rhythms do
not require a workflow engine. Workflow configuration/execution requires the
existing workflow schema. No separate scheduler or opportunity identity is added;
an opportunity can create a proposal through this API once its own contract is
available. Today UI work can use this contract without changing legacy goal APIs.

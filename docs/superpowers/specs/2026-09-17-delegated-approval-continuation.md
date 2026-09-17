# A3: delegated approvals pause the workflow and continue durably

## Contract

A `jarvis-agent.delegate` step runs a sub-agent that may call tools. A tool
call the gate says needs approval no longer ends as a denial inside the
conversation. It becomes a workflow effect of its own, the run parks on its
approval, and after the decision the same step continues the conversation
from where it stopped.

| Moment | What happens |
| --- | --- |
| Delegation starts | One `agent` effect records that delegating was allowed. It authorizes; it runs nothing. |
| A governed tool call | An `agent-tool:N` effect (N is the call's position in the conversation) carries the tool name, its frozen arguments, the run, version, step and loop position. The boundary parks the run on an approval; nothing runs. The gate audits `approval_required`, not executed. |
| The step parks | The sub-agent's message log, the pending call and the calls its turn did not reach are saved in `workflow_delegation`, bound to the version digest. The step answers `status: approval_required` with the waitpoint. |
| Approve | The scheduler resumes the run, the engine runs the step again, the delegation loads its checkpoint and asks the boundary for the same call. The boundary revalidates emergency state, run status, Authority and the version digest, dispatches once under its own claim, and records the receipt. The result joins the conversation and the agent continues. |
| Decline or expiry | The call becomes `[APPROVAL DENIED]` in the conversation. The agent finishes with that knowledge; the tool never runs. |
| Restart while parked | The checkpoint and the effect are durable. The next process resumes exactly as above. |
| Finished | The result is kept in the checkpoint and the log dropped. A step the engine runs again answers from the record without a new conversation. |

The step's `outcome` is the declared business contract. `requiredTools` names
the tools that must have completed; `succeeded` means the conversation
finished and every required tool has a result and no error. `error` codes:
`REQUIRED_TOOL_NOT_COMPLETED`, `AGENT_INCOMPLETE` (iteration limit),
`AGENT_ERROR`, `AGENT_CANCELED`. By default a failed outcome answers 422
and the piece stops the step; `requireSuccess: false` answers 200 with the
outcome as data for a router branch.

## Invariants this protects

- No effect before approval. The gate hands a governed call to the
  boundary, which creates the effect record and the approval in one
  transaction and returns the waitpoint; the tool registry is not touched.
- The audit row says what happened. `approval_required` and `denied` rows
  carry `executed: false`; an `allowed` row is written after the tool
  returned or threw, with `executed` matching. The boundary audits the
  dispatch it makes under an approval.
- One dispatch per approved call. The `agent-tool:N` effect has the same
  claim, receipt and replay refusal as every other workflow effect. Asked
  again, the boundary answers from the record. A second surface cannot run
  it, and a crash during dispatch leaves an uncertain effect that is never
  replayed.
- Binding. The approval is bound to run, version digest, step, loop
  position, tool name, frozen arguments and target, and the checkpoint to
  the version digest, role and goal. An edited version or a changed input
  refuses to resume.
- The conversation continues, it does not restart. The saved log includes
  the assistant turn that made the paused call; on resume the approved
  result is appended in its place, the calls that turn did not reach are
  dispatched in order (each may pause again), and the loop continues from
  the next iteration.
- A finished conversation is not a business outcome. Without
  `requiredTools`, `succeeded` says only that the agent finished cleanly.

## What this does not do

- The outer `agent` effect authorizes delegation and is not a receipt for
  what the sub-agent did; the `agent-tool:N` effects and the trace are.
- A delegated tool the gate allows outright still runs directly inside the
  sub-agent, as before, with its own audit row; only calls that need
  approval go through the boundary.
- A tool that throws under an approval ends the delegation as an error
  after the boundary records the failed effect. The agent does not get to
  retry it in the same conversation.
- The checkpoint stores the sub-agent's message log for the duration of
  the pause, including tool results. It is dropped when the delegation
  finishes and deleted with the run.
- Required tools are matched by name in the trace. A tool that ran and
  returned an error string is not completed; a tool that ran twice counts
  once.
- The LLM-only fallback (no orchestrator wired) has no tools and no
  pauses; its outcome is evaluated at the route from its status.

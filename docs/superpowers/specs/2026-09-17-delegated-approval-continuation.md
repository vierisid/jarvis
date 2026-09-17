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
| A turn completes | The conversation so far is checkpointed in `workflow_delegation` as `running`. |
| A governed tool call | An `agent-tool:N` effect (N is the call's position in the conversation) carries the tool name, its frozen arguments, the run, version, step and loop position, and the sub-agent's identity. The boundary parks the run on an approval; nothing runs. The gate audits `approval_required`, not executed. |
| The step parks | The message log, the pending call, the calls its turn did not reach and the taint the agent had read are saved as `paused`, bound to the version digest. The step answers `status: approval_required` with the waitpoint. |
| Approve | The scheduler resumes the run, the engine runs the step again, the delegation loads its checkpoint and asks the boundary for the same call. The boundary revalidates emergency state, run status, the version digest and Authority for the same principal, dispatches once under its own claim, and records the receipt. The result joins the conversation and the agent continues. |
| Decline or expiry | The call becomes `[APPROVAL DENIED]` in the conversation. The agent finishes with that knowledge; the tool never runs. |
| Restart while parked or running | The checkpoint and the effects are durable. The next process resumes from the pending call, or from the turn after the last completed one. |
| Finished | The result is kept in the checkpoint and the log dropped. A step the engine runs again answers from the record without a new conversation. |

The step's `outcome` is the declared business contract. `requiredTools` names
the tools that must have completed; `succeeded` means the conversation
finished and every required tool has a result that is not a failure,
denial or refusal. `error` codes: `REQUIRED_TOOL_NOT_COMPLETED`,
`AGENT_INCOMPLETE` (iteration limit), `AGENT_ERROR`, `AGENT_CANCELED`. By
default a failed outcome answers 422 and the piece stops the step;
`requireSuccess: false` answers 200 with the outcome as data for a router
branch. A step answered from its record applies the declaration it is
asked with now.

## Invariants this protects

- No effect before approval. The gate hands a governed call to the
  boundary, which saves the pending effect record, then creates the
  approval and waitpoint together, and returns the waitpoint; the tool
  registry is not touched.
- One principal. The boundary judges a delegated call as the sub-agent the
  gate judged it for, with the same role, level and merged profile, and a
  gate that required approval is never overruled by a looser
  recomputation. A role-scoped rule that requires approval parks the run; a
  level the sub-agent holds is not judged as the workflow's.
- The audit row says what happened. `approval_required` and `denied` rows
  carry `executed: false`, an `allowed` row is written after the tool
  returned or threw, and an attempt the dispatch itself failed still gets
  its row. The boundary audits the dispatch it makes under an approval.
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
  dispatched in order (each may pause again), the taint the agent had read
  is restored, and the loop continues from the next iteration.
- Failure is reported, not guessed. The runner marks each tool call whose
  result was a failure, denial or refusal, and the trace and the outcome
  read that mark rather than the text of the result.
- The same envelope as the direct tool piece. A tool whose effect a
  category cannot describe (`run_command`, browser clicks and typing) is
  refused before it reaches the boundary; the agent sees the refusal.
- A blocked call is a denial the agent sees. When the boundary refuses the
  pending call on resume and finalizes its effect as blocked (emergency
  state, a run no longer running), the call is over for good, as it is for a
  direct tool; the conversation continues with `[APPROVAL DENIED]` and the
  declared outcome reports it. A refusal that leaves the effect as it was
  (a changed version, an uncertain or already claimed earlier attempt) is
  this run's error, not the delegation's: the step fails without touching
  the checkpoint.
- A finished conversation is not a business outcome. Without
  `requiredTools`, `succeeded` says only that the agent finished cleanly.
- A stopped run keeps no conversation. Cancelling a run deletes its
  delegation rows; deleting the run cascades.

## What this does not do

- The outer `agent` effect authorizes delegation and is not a receipt for
  what the sub-agent did; the `agent-tool:N` effects and the trace are.
- A delegated tool the gate allows outright still runs directly inside the
  sub-agent, as before, with its own audit row and no durable record. A
  process that dies inside a turn repeats that turn's model call on the next
  run, and such a tool called in that turn runs again; the governed calls of
  that turn do not, because each has its own effect.
- A tool that throws under an approval is recorded as a typed failed
  effect (`TOOL_FAILED`) and is a failed result the agent sees and continues
  from; the effect is never re-dispatched.
- The checkpoint stores the sub-agent's message log, including tool
  results, while the delegation is running or parked. It is dropped when
  the delegation finishes or the run is cancelled, and deleted with the
  run. A parked run whose approval is never decided keeps it until then.
- Required tools are matched by name in the trace. A tool that ran twice
  counts once.
- Temporary grants are not carried to the boundary; a workflow sub-agent
  inherits none.
- The LLM-only fallback (no orchestrator wired) has no tools and no
  pauses; its outcome is evaluated at the route from its status.

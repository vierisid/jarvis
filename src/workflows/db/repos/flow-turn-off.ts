/**
 * Q-06: turning a workflow off stops what it started. The runs it had queued
 * or left waiting on a timer or an approval are stopped, each saying why, and
 * nothing can wake them later: every continuation path asks
 * `turnedOffReason` first. A run executing at that moment is not interrupted;
 * if it pauses, it does not continue. The background tasks it already started
 * are cancelled (#1152). Runs started by hand on a workflow that
 * is already off (a test run) are not affected: only runs created before it
 * was turned off are.
 */
import { getWorkflowDb } from "../index";
import { ActionOutcomeError } from "../../../actions/action-outcome";
import { cancelFlowRun } from "./run-cancellation";
import { signalCodeStepsRevoked, signalRunTurnedOff } from "../../runtime/cancellation-signals";
import { CODE_STEPS_REFUSAL_CODE } from "./flow-code-steps";
import { findCodeStepNames } from "../flow-graph";
import type { FlowTriggerNode } from "./flow-version";
import { clearScheduleWatch, recordFire } from "./trigger-fire";

export const TURNED_OFF_REASON = "The workflow was turned off, so this run was stopped.";

/**
 * Why this run must not start or continue, or null: its workflow was turned
 * off after the run was created. Turning the workflow back on, or publishing
 * it, does not revive a run the turn-off stopped or should have stopped.
 */
export function turnedOffReason(runId: string): string | null {
  const row = getWorkflowDb().query<{ disabled_at: number | null; created: number }, [string]>(
    `SELECT f.disabled_at, r.created FROM flow_run r JOIN flow f ON f.id = r.flow_id WHERE r.id = ?`,
  ).get(runId);
  return row && row.disabled_at !== null && row.created <= row.disabled_at ? TURNED_OFF_REASON : null;
}

export const CHILD_TURNED_OFF = "Child workflow is turned off. Turn it on again to let other workflows call it.";
/**
 * Whether a person turned this workflow off (#1242): it was on, and is off now.
 * A workflow saved off that was never turned on (a reusable child made only to
 * be called) is not turned off; a parent may still call it.
 */
export function isTurnedOff(flow: { status: string; disabled_at?: number | null }): boolean {
  return flow.status === "DISABLED" && flow.disabled_at != null;
}

/** The refusal a calling step records: blocked, and nothing was started. */
export function childTurnedOffOutcome(): ActionOutcomeError {
  return new ActionOutcomeError({ status: "blocked", code: "FLOW_TURNED_OFF", message: CHILD_TURNED_OFF, effect: "not_started" });
}

/** Stop one run of a turned-off workflow and record it. Call outside any transaction. */
export function stopTurnedOffRun(flowId: string, runId: string): boolean {
  const result = cancelFlowRun(runId, { reason: TURNED_OFF_REASON, reasonLabel: "Workflow turned off" });
  if (result.accepted) recordFire({ flowId, source: "lifecycle", outcome: "stopped", runId, detail: { reason: TURNED_OFF_REASON } });
  return result.accepted;
}

/**
 * After a flow is turned off: stop its queued and waiting runs, cancel the
 * background tasks its executing runs started (the runs themselves go on,
 * #1152), and forget what its schedule was owed. Returns how many runs were
 * stopped. Idempotent: telling an executing run again cancels nothing more.
 */
export function stopRunsOfTurnedOffFlow(flowId: string): number {
  clearScheduleWatch(flowId);
  const rows = getWorkflowDb().query<{ id: string; status: string }, [string]>(
    `SELECT r.id, r.status FROM flow_run r JOIN flow f ON f.id = r.flow_id
      WHERE r.flow_id = ? AND f.disabled_at IS NOT NULL
        AND r.created <= f.disabled_at AND r.status IN ('QUEUED', 'RUNNING', 'PAUSED')`,
  ).all(flowId);
  let stopped = 0;
  for (const { id, status } of rows) {
    if (status === 'RUNNING') signalRunTurnedOff(id);
    else if (stopTurnedOffRun(flowId, id)) stopped++;
  }
  return stopped;
}

export const DELETED_REASON = "The workflow was deleted, so this run was stopped.";

/**
 * Before a workflow is deleted: stop everything it still has in flight, so an
 * engine mid-run is told to stop now rather than at its next daemon call, and
 * leave a record that outlives the runs the delete removes.
 */
export function stopRunsOfDeletedFlow(flowId: string, onCardClosed?: (approvalId: string) => void): number {
  clearScheduleWatch(flowId);
  const rows = getWorkflowDb().query<{ id: string }, [string]>(
    `SELECT id FROM flow_run WHERE flow_id = ? AND status IN ('QUEUED', 'RUNNING', 'PAUSED')`,
  ).all(flowId);
  let stopped = 0;
  for (const { id } of rows) {
    const result = cancelFlowRun(id, { reason: DELETED_REASON, reasonLabel: "Workflow deleted" });
    if (onCardClosed) result.closedApprovalIds.forEach(onCardClosed);
    if (!result.accepted) continue;
    recordFire({ flowId, source: "lifecycle", outcome: "stopped", runId: id, detail: { reason: DELETED_REASON } });
    stopped++;
  }
  return stopped;
}

export const CODE_REVOKED_REASON = "CODE steps stopped being allowed for this workflow, so this run was stopped. "
  + "Allow CODE steps in the workflow's permissions and start it again.";

/**
 * After the owner takes the CODE-step permission back (#1426): stop every run
 * of the flow that is queued, waiting or executing on a version with a CODE
 * step, executing ones included (their engine is stopped), so no CODE step
 * runs after the revoke, then retire a warm engine parked for the flow. A run
 * on a version without CODE steps is left alone. Call outside any transaction,
 * right after the permission is written: nothing awaits in between, so a run
 * either read the grant before (and is stopped here) or reads it after (and
 * is refused). Returns how many runs were stopped.
 */
export function stopRunsOfRevokedCodeSteps(flowId: string): number {
  const db = getWorkflowDb();
  const flow = db.query<{ code_steps_enabled: number }, [string]>("SELECT code_steps_enabled FROM flow WHERE id = ?").get(flowId);
  if (!flow || flow.code_steps_enabled === 1) return 0;
  const rows = db.query<{ id: string; trigger: string }, [string]>(
    `SELECT r.id, v.trigger FROM flow_run r JOIN flow_version v ON v.id = r.flow_version_id
      WHERE r.flow_id = ? AND r.status IN ('QUEUED', 'RUNNING', 'PAUSED')`,
  ).all(flowId);
  let stopped = 0;
  for (const { id, trigger } of rows) {
    let graph: FlowTriggerNode | null = null;
    try { graph = JSON.parse(trigger) as FlowTriggerNode; } catch { graph = null; }
    // An unreadable graph cannot be shown to be free of CODE: stopped too.
    if (graph && findCodeStepNames(graph).length === 0) continue;
    const result = cancelFlowRun(id, { reason: CODE_REVOKED_REASON, reasonLabel: "CODE steps not allowed" });
    if (!result.accepted) continue;
    recordFire({ flowId, source: "lifecycle", outcome: "stopped", runId: id, detail: { reason: CODE_REVOKED_REASON, code: CODE_STEPS_REFUSAL_CODE } });
    stopped++;
  }
  signalCodeStepsRevoked(flowId);
  return stopped;
}

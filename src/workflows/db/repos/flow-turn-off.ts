/**
 * Q-06: turning a workflow off stops what it started. The runs it had queued
 * or left waiting on a timer or an approval are stopped, each saying why, and
 * nothing can wake them later: every continuation path asks
 * `turnedOffReason` first. A run executing at that moment is not interrupted;
 * if it pauses, it does not continue. Runs started by hand on a workflow that
 * is already off (a test run) are not affected: only runs created before it
 * was turned off are.
 */
import { getWorkflowDb } from "../index";
import { cancelFlowRun } from "./run-cancellation";
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

/** Stop one run of a turned-off workflow and record it. Call outside any transaction. */
export function stopTurnedOffRun(flowId: string, runId: string): boolean {
  const result = cancelFlowRun(runId, { reason: TURNED_OFF_REASON, reasonLabel: "Workflow turned off" });
  if (result.accepted) recordFire({ flowId, source: "lifecycle", outcome: "stopped", runId, detail: { reason: TURNED_OFF_REASON } });
  return result.accepted;
}

/**
 * After a flow is turned off: stop its queued and waiting runs, and forget
 * what its schedule was owed. Returns how many runs were stopped.
 */
export function stopRunsOfTurnedOffFlow(flowId: string): number {
  clearScheduleWatch(flowId);
  const rows = getWorkflowDb().query<{ id: string }, [string]>(
    `SELECT r.id FROM flow_run r JOIN flow f ON f.id = r.flow_id
      WHERE r.flow_id = ? AND f.disabled_at IS NOT NULL
        AND r.created <= f.disabled_at AND r.status IN ('QUEUED', 'PAUSED')`,
  ).all(flowId);
  let stopped = 0;
  for (const { id } of rows) if (stopTurnedOffRun(flowId, id)) stopped++;
  return stopped;
}

export const DELETED_REASON = "The workflow was deleted, so this run was stopped.";

/**
 * Before a workflow is deleted: stop everything it still has in flight, so an
 * engine mid-run is told to stop now rather than at its next daemon call, and
 * leave a record that outlives the runs the delete removes.
 */
export function stopRunsOfDeletedFlow(flowId: string): number {
  clearScheduleWatch(flowId);
  const rows = getWorkflowDb().query<{ id: string }, [string]>(
    `SELECT id FROM flow_run WHERE flow_id = ? AND status IN ('QUEUED', 'RUNNING', 'PAUSED')`,
  ).all(flowId);
  let stopped = 0;
  for (const { id } of rows) {
    const result = cancelFlowRun(id, { reason: DELETED_REASON, reasonLabel: "Workflow deleted" });
    if (!result.accepted) continue;
    recordFire({ flowId, source: "lifecycle", outcome: "stopped", runId: id, detail: { reason: DELETED_REASON } });
    stopped++;
  }
  return stopped;
}

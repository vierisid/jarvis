import { getWorkflowDb } from "../index";
import { signalRunCanceled } from "../../runtime/cancellation-signals";
import { deleteDelegations } from "./delegation";
import { listWorkflowEffects, saveWorkflowEffect } from "./workflow-effect";

export interface RunCancellation {
  runId: string;
  /** When the durable dispatch fence closed, not proof of remote rollback. */
  acknowledgedAt: number;
  statusAtRequest: string;
  /** Historical uncertainty at acknowledgement; receipts remain authoritative. */
  inFlightMayHaveCompleted: boolean;
}

export function getRunCancellation(runId: string): RunCancellation | null {
  const row = getWorkflowDb().query<{
    run_id: string; acknowledged_at: number; status_at_request: string; in_flight_may_have_completed: number;
  }, [string]>("SELECT * FROM workflow_run_cancellation WHERE run_id = ?").get(runId);
  return row ? {
    runId: row.run_id, acknowledgedAt: row.acknowledged_at,
    statusAtRequest: row.status_at_request, inFlightMayHaveCompleted: row.in_flight_may_have_completed !== 0,
  } : null;
}

/** Caller holds the transaction and has established that the run cannot continue. */
function retireRunWaits(runId: string, ts: number, canceled: boolean): void {
  const db = getWorkflowDb();
  // Pending effects provably never dispatched. Leave in-flight and final
  // effects alone: cleanup cannot certify rollback or replace their receipts.
  for (const effect of listWorkflowEffects(runId)) {
    if (effect.status !== 'pending') continue;
    effect.status = 'blocked'; effect.finishedAt = ts;
    effect.error = canceled ? 'Workflow canceled before dispatch' : 'Workflow ended before dispatch';
    effect.outcome = { status: 'blocked', code: canceled ? 'WORKFLOW_CANCELED' : 'WORKFLOW_FINISHED',
      message: effect.error, effect: 'not_started' };
    saveWorkflowEffect(effect);
    if (effect.approvalId) {
      db.run(`UPDATE approval_requests SET status='denied', decided_at=?, decided_by=?
        WHERE id=? AND execution_mode='workflow' AND status='pending'`,
      [ts, canceled ? 'workflow-cancellation' : 'workflow-completion', effect.approvalId]);
      db.run(`UPDATE approval_requests SET status='executed', executed_at=?, execution_result=?, execution_outcome='blocked'
        WHERE id=? AND execution_mode='workflow' AND status='approved'`, [ts, effect.error, effect.approvalId]);
    }
  }
  db.run('UPDATE waitpoint SET resumed_at=? WHERE flow_run_id=? AND resumed_at IS NULL', [ts, runId]);
}

/** Retire abandoned waits without changing a terminal run's status or failure evidence. */
export function retireTerminalRunWaits(runId: string): void {
  const db = getWorkflowDb();
  db.transaction(() => {
    const run = db.query<{ status: string }, [string]>('SELECT status FROM flow_run WHERE id=?').get(runId);
    if (!run || ['QUEUED', 'RUNNING', 'PAUSED'].includes(run.status)) return;
    retireRunWaits(runId, Date.now(), false);
  }).immediate();
}

/**
 * Atomically stop the run and ALL its queued attempts, including legacy jobs.
 * A `reason` is kept on the stopped run (its failed step), so a run stopped
 * because its workflow was turned off says so (Q-06). Required descendants
 * stopped with it keep the plain cancellation: the reason names the root's
 * workflow, not theirs.
 */
export function cancelFlowRun(runId: string, opts: { reason?: string; reasonLabel?: string } = {}): {
  accepted: boolean; jobCanceled: boolean; cancellation: RunCancellation | null;
} {
  const db = getWorkflowDb();
  const stopped: string[] = [];
  const stop = (id: string) => {
    const run = db.query<{ status: string; start_time: number | null }, [string]>(
      "SELECT status, start_time FROM flow_run WHERE id = ?",
    ).get(id);
    if (!run) throw new Error(`run not found: ${id}`);
    let cancellation = getRunCancellation(id);
    if (!cancellation && !["QUEUED", "RUNNING", "PAUSED"].includes(run.status)) {
      return { accepted: false, jobCanceled: false, cancellation: null };
    }
    const ts = Date.now();
    if (!cancellation) {
      db.run(`INSERT INTO workflow_run_cancellation
        (run_id, acknowledged_at, status_at_request, in_flight_may_have_completed)
        VALUES (?, ?, ?, ?)`, [id, ts, run.status, run.status === "RUNNING" || run.start_time !== null ? 1 : 0]);
      cancellation = getRunCancellation(id)!;
    }
    const jobs = db.run(`UPDATE workflow_job SET status = 'CANCELED', locked_until = NULL, updated = ?
      WHERE job_type = 'RUN_FLOW' AND status IN ('QUEUED', 'RUNNING')
        AND (flow_run_id = ? OR (flow_run_id IS NULL AND CASE WHEN json_valid(payload) THEN json_extract(payload, '$.runId') END = ?))`, [ts, id, id]);
    db.run("UPDATE flow_run SET status = 'STOPPED', finish_time = ?, updated = ? WHERE id = ?",
      [cancellation.acknowledgedAt, ts, id]);
    retireRunWaits(id, ts, true);
    stopped.push(id);
    if (opts.reason && id === runId) {
      db.run("UPDATE flow_run SET failed_step = ? WHERE id = ?", [JSON.stringify({
        name: "<lifecycle>", displayName: opts.reasonLabel ?? "Stopped", errorMessage: opts.reason }), id]);
    }
    // A stopped run never resumes a delegated conversation; drop its log.
    deleteDelegations(id);
    return { accepted: true, jobCanceled: jobs.changes > 0, cancellation };
  };
  const result = db.transaction(() => {
    const result = stop(runId);
    if (!result.accepted) return result;
    // Required descendants share the parent's stop decision. Independent
    // fire-and-forget children retain their existing lifecycle.
    const visited = new Set([runId]);
    const descendants = [runId];
    for (let i = 0; i < descendants.length; i++) {
      const children = db.query(`SELECT c.child_run_id FROM workflow_child_run c
        JOIN workflow_effect e ON e.id=c.effect_id JOIN flow_run r ON r.id=c.child_run_id
        WHERE e.run_id=? AND c.waitpoint_id IS NOT NULL`).all(descendants[i]!) as Array<{ child_run_id: string }>;
      for (const child of children) {
        if (visited.has(child.child_run_id)) continue;
        visited.add(child.child_run_id);
        descendants.push(child.child_run_id);
        stop(child.child_run_id);
      }
    }
    return result;
  }).immediate();
  // Never announce cancellation until the entire tree transaction commits.
  for (const id of stopped) signalRunCanceled(id);
  return result;
}

/** Upgrade canceled jobs left by older daemons without reviving finished runs. */
export function recoverCanceledRuns(): void {
  const rows = getWorkflowDb().query<{ id: string }, []>(`SELECT r.id FROM flow_run r
    WHERE r.status IN ('QUEUED', 'RUNNING', 'PAUSED') AND (
      EXISTS (SELECT 1 FROM workflow_run_cancellation c WHERE c.run_id = r.id)
      OR (SELECT j.status FROM workflow_job j WHERE j.job_type = 'RUN_FLOW'
          AND (j.flow_run_id = r.id OR (j.flow_run_id IS NULL AND CASE WHEN json_valid(j.payload) THEN json_extract(j.payload, '$.runId') END = r.id))
          ORDER BY j.created DESC, j.rowid DESC LIMIT 1) = 'CANCELED'
    )`).all();
  for (const row of rows) cancelFlowRun(row.id);
}

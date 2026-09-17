import { getWorkflowDb } from "../index";
import { signalRunCanceled } from "../../runtime/cancellation-signals";
import { deleteDelegations } from "./delegation";

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

/** Atomically stop the run and ALL its queued attempts, including legacy jobs. */
export function cancelFlowRun(runId: string): {
  accepted: boolean; jobCanceled: boolean; cancellation: RunCancellation | null;
} {
  const db = getWorkflowDb();
  const result = db.transaction(() => {
    const run = db.query<{ status: string; start_time: number | null }, [string]>(
      "SELECT status, start_time FROM flow_run WHERE id = ?",
    ).get(runId);
    if (!run) throw new Error(`run not found: ${runId}`);
    let cancellation = getRunCancellation(runId);
    if (!cancellation && !["QUEUED", "RUNNING", "PAUSED"].includes(run.status)) {
      return { accepted: false, jobCanceled: false, cancellation: null };
    }
    const ts = Date.now();
    if (!cancellation) {
      db.run(`INSERT INTO workflow_run_cancellation
        (run_id, acknowledged_at, status_at_request, in_flight_may_have_completed)
        VALUES (?, ?, ?, ?)`, [runId, ts, run.status, run.status === "RUNNING" || run.start_time !== null ? 1 : 0]);
      cancellation = getRunCancellation(runId)!;
    }
    const jobs = db.run(`UPDATE workflow_job SET status = 'CANCELED', locked_until = NULL, updated = ?
      WHERE job_type = 'RUN_FLOW' AND status IN ('QUEUED', 'RUNNING')
        AND (flow_run_id = ? OR (flow_run_id IS NULL AND CASE WHEN json_valid(payload) THEN json_extract(payload, '$.runId') END = ?))`, [ts, runId, runId]);
    db.run("UPDATE flow_run SET status = 'STOPPED', finish_time = ?, updated = ? WHERE id = ?",
      [cancellation.acknowledgedAt, ts, runId]);
    // A stopped run never resumes a delegated conversation; drop its log.
    deleteDelegations(runId);
    return { accepted: true, jobCanceled: jobs.changes > 0, cancellation };
  }).immediate();
  // Never announce cancellation until the write transaction commits.
  if (result.accepted) signalRunCanceled(runId);
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

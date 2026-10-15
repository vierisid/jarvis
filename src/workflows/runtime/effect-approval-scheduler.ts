import { getWorkflowDb } from '../db';
import { getFlowRun } from '../db/repos/flow-run';
import { getWaitpoint } from '../db/repos/waitpoint';
import { stopTurnedOffRun, turnedOffReason } from '../db/repos/flow-turn-off';
import { claimContinuation } from './continuation';

/** Durable polling covers every approval surface and decisions made before park. */
export function resumeResolvedWorkflowEffects(): number {
  const db = getWorkflowDb();
  const rows = db.query(`SELECT e.id, e.run_id, e.waitpoint_id FROM workflow_effect e
    JOIN approval_requests a ON a.id=e.approval_id
    JOIN waitpoint w ON w.id=e.waitpoint_id
    WHERE e.status='pending' AND a.execution_mode='workflow'
      AND a.status IN ('approved','denied','expired') AND w.resumed_at IS NULL`).all() as Array<{ id: string; run_id: string; waitpoint_id: string }>;
  let count = 0;
  for (const row of rows) {
    const run = getFlowRun(row.run_id);
    if (run?.status !== 'PAUSED') continue;
    // A workflow turned off since this run began does not continue, approved
    // or not: the run is stopped instead (Q-06).
    if (turnedOffReason(run.id)) { stopTurnedOffRun(run.flowId, run.id); continue; }
    if (db.query("SELECT id FROM workflow_job WHERE flow_run_id=? AND status IN ('QUEUED','RUNNING','CANCELED') LIMIT 1").get(row.run_id)) continue;
    const waitpoint = getWaitpoint(row.waitpoint_id);
    if (!waitpoint) continue;
    if (claimContinuation({ runId: run.id, waitpoint, kind: 'approval', resumePayload: { workflowEffectId: row.id } }) === 'resumed') count++;
  }
  return count;
}

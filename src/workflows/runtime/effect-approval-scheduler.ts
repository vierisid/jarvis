import { getWorkflowDb } from '../db';
import { getFlowRun } from '../db/repos/flow-run';
import { enqueue } from '../db/repos/job-queue';
import { markWaitpointResumed } from '../db/repos/waitpoint';

/** Durable polling covers every approval surface and decisions made before park. */
export function resumeResolvedWorkflowEffects(): number {
  const db = getWorkflowDb();
  const rows = db.query(`SELECT e.id, e.run_id, e.waitpoint_id FROM workflow_effect e
    JOIN approval_requests a ON a.id=e.approval_id
    JOIN waitpoint w ON w.id=e.waitpoint_id
    WHERE e.status='pending' AND a.execution_mode='workflow'
      AND a.status IN ('approved','denied','expired') AND w.resumed_at IS NULL
      AND NOT (a.status='expired' AND EXISTS (SELECT 1 FROM brief_decision_document d WHERE d.approval_id=a.id))`).all() as Array<{ id: string; run_id: string; waitpoint_id: string }>;
  let count = 0;
  for (const row of rows) {
    const resumed = db.transaction(() => {
      if (!db.query(`SELECT 1 FROM workflow_effect e JOIN approval_requests a ON a.id=e.approval_id
        WHERE e.id=? AND e.status='pending' AND e.waitpoint_id=? AND (a.status IN ('approved','denied')
          OR (a.status='expired' AND NOT EXISTS (SELECT 1 FROM brief_decision_document d WHERE d.approval_id=a.id)))`).get(row.id, row.waitpoint_id)) return false;
      if (getFlowRun(row.run_id)?.status !== 'PAUSED') return false;
      if (db.query("SELECT id FROM workflow_job WHERE flow_run_id=? AND status IN ('QUEUED','RUNNING','CANCELED') LIMIT 1").get(row.run_id)) return false;
      if (!markWaitpointResumed(row.waitpoint_id)) return false;
      enqueue({ jobType: 'RUN_FLOW', flowRunId: row.run_id, maxAttempts: 1,
        payload: { runId: row.run_id, executionType: 'RESUME', resumePayload: { workflowEffectId: row.id } } });
      return true;
    }).immediate();
    if (resumed) count++;
  }
  return count;
}

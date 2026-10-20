import { getWorkflowDb } from '../db';
import { getChildRun } from '../db/repos/child-run';
import { cancelFlowRun, retireTerminalRunWaits } from '../db/repos/run-cancellation';
import { getFlowRun } from '../db/repos/flow-run';
import { enqueue } from '../db/repos/job-queue';
import { markWaitpointResumed } from '../db/repos/waitpoint';

/** Required children continue their parent through the ordinary outer worker.
 * Polling survives daemon downtime and child completion before the parent parks.
 * `onCardClosed` hears each card this sweep closed, so the dashboard stops
 * offering it (#1039). A throw from it is logged and the sweep goes on. */
export function resumeCompletedChildRuns(onCardClosed?: (approvalId: string) => void): number {
  const db = getWorkflowDb();
  // A parent can fail after child dispatch but before its PAUSED upload, or
  // disappear through flow deletion. The child row retains this ownership
  // even when deletion cascades the parent's effect/link away.
  const abandoned = db.query(`SELECT c.id FROM flow_run c LEFT JOIN flow_run p ON p.id=c.parent_run_id
    WHERE c.fail_parent_on_failure=1 AND c.parent_run_id IS NOT NULL
      AND c.status IN ('QUEUED','RUNNING','PAUSED')
      AND (p.id IS NULL OR p.status NOT IN ('QUEUED','RUNNING','PAUSED'))`).all() as Array<{ id: string }>;
  const report = (approvalId: string) => {
    try { onCardClosed?.(approvalId); } catch (error) { console.error('[Workflow Authority] closed card update failed:', error); }
  };
  for (const child of abandoned) cancelFlowRun(child.id).closedApprovalIds.forEach(report);
  // A run can create an approval and then fail before publishing PAUSED.
  // Cancel refuses already-terminal runs, so retire their undispatched waits
  // separately: a required child's, including while the parent is still
  // awaiting continuation, and any other run's pending effect (#1039), whose
  // card would otherwise stay pending and approvable for good although
  // approving it resumes nothing. Driven from the pending effects, so a sweep
  // reads only what is still waiting, not every finished run.
  const finished = db.query(`SELECT c.id FROM flow_run c
    WHERE c.fail_parent_on_failure=1 AND c.parent_run_id IS NOT NULL
      AND c.status NOT IN ('QUEUED','RUNNING','PAUSED')
      AND (EXISTS (SELECT 1 FROM workflow_effect e WHERE e.run_id=c.id AND e.status='pending')
        OR EXISTS (SELECT 1 FROM waitpoint w WHERE w.flow_run_id=c.id AND w.resumed_at IS NULL))
    UNION SELECT r.id FROM workflow_effect e JOIN flow_run r ON r.id=e.run_id
    WHERE e.status='pending' AND r.status NOT IN ('QUEUED','RUNNING','PAUSED')`)
    .all() as Array<{ id: string }>;
  for (const run of finished) retireTerminalRunWaits(run.id).forEach(report);
  db.run(`UPDATE waitpoint SET resumed_at=? WHERE resumed_at IS NULL AND id IN (
    SELECT c.waitpoint_id FROM workflow_child_run c JOIN workflow_effect e ON e.id=c.effect_id
      JOIN flow_run p ON p.id=e.run_id WHERE p.status NOT IN ('QUEUED','RUNNING','PAUSED'))`, [Date.now()]);
  const rows = db.query(`SELECT c.effect_id FROM workflow_child_run c
    JOIN workflow_effect e ON e.id=c.effect_id JOIN waitpoint w ON w.id=c.waitpoint_id
    WHERE e.status='succeeded' AND w.resumed_at IS NULL`).all() as Array<{ effect_id: string }>;
  let count = 0;
  for (const row of rows) {
    const resumed = db.transaction(() => {
      const child = getChildRun(row.effect_id);
      if (!child?.outcome || !child.waitpointId || getFlowRun(child.parentRunId)?.status !== 'PAUSED') return false;
      if (db.query("SELECT id FROM workflow_job WHERE flow_run_id=? AND status IN ('QUEUED','RUNNING','CANCELED') LIMIT 1").get(child.parentRunId)) return false;
      if (!markWaitpointResumed(child.waitpointId)) return false;
      enqueue({ jobType: 'RUN_FLOW', flowRunId: child.parentRunId, maxAttempts: 1,
        payload: { runId: child.parentRunId, executionType: 'RESUME', resumePayload: { childRunId: child.childRunId } } });
      return true;
    }).immediate();
    if (resumed) count++;
  }
  return count;
}

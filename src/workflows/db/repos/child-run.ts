import { getWorkflowDb } from '../index';
import { getFlowRun, type FlowRunStatus } from './flow-run';
import { getWorkflowEffect } from './workflow-effect';
import type { ActionOutcome } from '../../../actions/action-outcome';

export interface ChildRun {
  effectId: string;
  parentRunId: string;
  stepName: string;
  executionPath: Array<[string, number]>;
  childRunId: string;
  waitpointId: string | null;
  status: FlowRunStatus | 'MISSING';
  outcome?: ActionOutcome;
}

export function getChildRun(effectId: string): ChildRun | null {
  const row = getWorkflowDb().query('SELECT child_run_id, waitpoint_id FROM workflow_child_run WHERE effect_id=?')
    .get(effectId) as { child_run_id: string; waitpoint_id: string | null } | null;
  const effect = row && getWorkflowEffect(effectId);
  if (!row || !effect) return null;
  const run = getFlowRun(row.child_run_id);
  const status = run?.status ?? 'MISSING';
  const active = ['QUEUED', 'RUNNING', 'PAUSED'].includes(status);
  // A timeout/stop or an interrupted dispatch cannot certify non-execution.
  const uncertain = !run || Boolean(getWorkflowDb().query(`WITH RECURSIVE descendants(id) AS (
    SELECT ? UNION SELECT c.child_run_id FROM descendants d
      JOIN workflow_effect e ON e.run_id=d.id JOIN workflow_child_run c ON c.effect_id=e.id
      WHERE c.waitpoint_id IS NOT NULL
    ) SELECT d.id FROM descendants d LEFT JOIN flow_run r ON r.id=d.id
      WHERE r.id IS NULL OR r.status IN ('TIMEOUT','STOPPED','QUEUED','RUNNING','PAUSED')
        OR EXISTS (SELECT 1 FROM workflow_effect e WHERE e.run_id=d.id AND e.status IN ('unknown','dispatching'))
      LIMIT 1`).get(row.child_run_id));
  const outcome: ActionOutcome | undefined = active ? undefined : status === 'SUCCEEDED' && !uncertain
    ? { status: 'succeeded' }
    : { status: uncertain ? 'unknown' : 'error', code: uncertain ? 'CHILD_RUN_UNCERTAIN' : 'CHILD_RUN_FAILED',
        message: `Child run ${row.child_run_id} ended ${status}${uncertain ? ' with an uncertain effect' : ''}; inspect its run and effect receipts`,
        effect: 'may_have_occurred' };
  return { effectId, parentRunId: effect.runId, stepName: effect.stepName, executionPath: effect.executionPath,
    childRunId: row.child_run_id, waitpointId: row.waitpoint_id, status, ...(outcome ? { outcome } : {}) };
}

export function listChildRuns(parentRunId: string): ChildRun[] {
  const rows = getWorkflowDb().query(`SELECT c.effect_id FROM workflow_child_run c
    JOIN workflow_effect e ON e.id=c.effect_id WHERE e.run_id=? ORDER BY e.rowid`)
    .all(parentRunId) as Array<{ effect_id: string }>;
  return rows.map(row => getChildRun(row.effect_id)!);
}

import { getWorkflowDb } from '../index';
import { ActionOutcomeError } from '../../../actions/action-outcome';

export interface RunMachineBinding {
  runId: string;
  sidecarId: string | null;
  sessionId: string | null;
  selectedBy: 'implicit' | 'explicit';
  boundAt: number;
}

export function getRunMachineBinding(runId: string): RunMachineBinding | null {
  const row = getWorkflowDb().query('SELECT record FROM workflow_run_machine_binding WHERE run_id=?')
    .get(runId) as { record: string } | null;
  return row ? JSON.parse(row.record) : null;
}

export function machineBindingBlocked(code: string, reason: string): never {
  throw new ActionOutcomeError({ status: 'blocked', code, effect: 'not_started',
    message: `${reason} No action was dispatched. Review the recorded results and start a new run with an explicit target and fresh approvals; do not replay completed work.` });
}

/** One first writer per run, including across concurrent service instances. */
export function ensureRunMachineBinding(runId: string, projectId: string, select: () => Omit<RunMachineBinding, 'runId' | 'boundAt'>): RunMachineBinding {
  const db = getWorkflowDb();
  return db.transaction(() => {
    const run = db.query('SELECT project_id, status FROM flow_run WHERE id=?').get(runId) as { project_id: string; status: string } | null;
    if (!run || run.project_id !== projectId || run.status !== 'RUNNING') {
      machineBindingBlocked('WORKFLOW_BINDING_IDENTITY', 'The machine binding does not match an active workflow run.');
    }
    const existing = getRunMachineBinding(runId);
    if (existing) return existing;
    // Old receipts have no connection generation. Never bless the currently
    // connected session as the one an older approval or completed action used.
    const prior = db.query(`SELECT 1 FROM workflow_effect WHERE run_id=? AND
      (json_extract(record, '$.target.selection') IN ('pinned-sidecar', 'local-host')
       OR json_type(record, '$.target.sidecarId') IS NOT NULL
       OR (json_extract(record, '$.route')='agent'
         AND COALESCE(json_extract(record, '$.provenance.machineBindingVersion'), 0) < 1)) LIMIT 1`).get(runId);
    if (prior) machineBindingBlocked('WORKFLOW_BINDING_LEGACY', 'Earlier workflow work has no verifiable machine/session binding.');
    const binding: RunMachineBinding = { ...select(), runId, boundAt: Date.now() };
    db.run('INSERT INTO workflow_run_machine_binding (run_id, record) VALUES (?, ?)', [runId, JSON.stringify(binding)]);
    return binding;
  }).immediate();
}

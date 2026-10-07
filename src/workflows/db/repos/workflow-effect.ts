import { getWorkflowDb } from '../index';
import type { ActionOutcome } from '../../../actions/action-outcome';

export type EffectStatus = 'pending' | 'dispatching' | 'succeeded' | 'failed' | 'blocked' | 'unknown';
export interface WorkflowEffect {
  id: string; runId: string; projectId: string; flowId: string; versionId: string;
  versionDigest: string; stepName: string; executionPath: Array<[string, number]>;
  route: string; toolName: string; actionCategory: string; requestDigest: string;
  arguments: Record<string, unknown>; target: Record<string, unknown>;
  provenance: Record<string, unknown>; decision: string; reason: string;
  status: EffectStatus; approvalId: string | null; waitpointId: string | null;
  result?: unknown; error?: string; createdAt: number; finishedAt?: number;
  /** Qualified failure receipt; successful returns already have status/result. */
  outcome?: ActionOutcome;
  /** F-14 document generation; unchanged by policy/receipt writes. */
  documentRevision?: number;
}
export function getWorkflowEffect(id: string): WorkflowEffect | null {
  const row = getWorkflowDb().query('SELECT record FROM workflow_effect WHERE id = ?').get(id) as { record: string } | null;
  return row ? JSON.parse(row.record) : null;
}
export function saveWorkflowEffect(effect: WorkflowEffect): void {
  const write = getWorkflowDb().run(`INSERT INTO workflow_effect (id, run_id, status, approval_id, waitpoint_id, record)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,
    approval_id=excluded.approval_id, waitpoint_id=excluded.waitpoint_id, record=excluded.record
    WHERE coalesce(json_extract(workflow_effect.record, '$.documentRevision'), 0) = coalesce(json_extract(excluded.record, '$.documentRevision'), 0)`,
  [effect.id, effect.runId, effect.status, effect.approvalId, effect.waitpointId, JSON.stringify(effect)]);
  if (!write.changes) throw new Error('Workflow document changed; stale effect write refused');
}
/** CAS is the dispatch fence. A crash after this point is uncertain, never retryable.
 * Bun's change count includes F-12's queue-clock trigger, so any positive count
 * means this single-ID update won. Zero alone means the fence rejected it. */
export function claimWorkflowEffect(effect: WorkflowEffect): boolean {
  return getWorkflowDb().run(`UPDATE workflow_effect SET status='dispatching', record=?
    WHERE id=? AND status='pending' AND approval_id IS ?
      AND coalesce(json_extract(record, '$.documentRevision'), 0) = ?`,
    [JSON.stringify({ ...effect, status: 'dispatching' }), effect.id, effect.approvalId, effect.documentRevision ?? 0]).changes > 0;
}
export function listWorkflowEffects(runId: string): WorkflowEffect[] {
  const rows = getWorkflowDb().query('SELECT record FROM workflow_effect WHERE run_id=? ORDER BY rowid').all(runId) as Array<{ record: string }>;
  return rows.map(row => JSON.parse(row.record));
}

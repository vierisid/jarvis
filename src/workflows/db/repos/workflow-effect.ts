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
  /**
   * Q-05: what the effect was recorded against beyond its arguments and target
   * (the memory facts a recipient matched), rechecked before approval and
   * dispatch. Outside the request digest and the target, so it never changes
   * what an approval was granted for.
   */
  bindings?: Record<string, unknown>;
  /**
   * Q-05: the last time the engine's retry of a succeeded authorization was
   * refused because those bindings stopped holding. The effect stays
   * succeeded; the service was not called again.
   */
  replayRefusal?: { outcome: ActionOutcome; at: number };
}
export function getWorkflowEffect(id: string): WorkflowEffect | null {
  const row = getWorkflowDb().query('SELECT record FROM workflow_effect WHERE id = ?').get(id) as { record: string } | null;
  return row ? JSON.parse(row.record) : null;
}
export function saveWorkflowEffect(effect: WorkflowEffect): void {
  getWorkflowDb().run(`INSERT INTO workflow_effect (id, run_id, status, approval_id, waitpoint_id, record)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,
    approval_id=excluded.approval_id, waitpoint_id=excluded.waitpoint_id, record=excluded.record`,
  [effect.id, effect.runId, effect.status, effect.approvalId, effect.waitpointId, JSON.stringify(effect)]);
}
/** CAS is the dispatch fence. A crash after this point is uncertain, never retryable. */
export function claimWorkflowEffect(effect: WorkflowEffect): boolean {
  return getWorkflowDb().run(`UPDATE workflow_effect SET status='dispatching', record=?
    WHERE id=? AND status='pending'`, [JSON.stringify({ ...effect, status: 'dispatching' }), effect.id]).changes === 1;
}
export function listWorkflowEffects(runId: string): WorkflowEffect[] {
  const rows = getWorkflowDb().query('SELECT record FROM workflow_effect WHERE run_id=? ORDER BY rowid').all(runId) as Array<{ record: string }>;
  return rows.map(row => JSON.parse(row.record));
}

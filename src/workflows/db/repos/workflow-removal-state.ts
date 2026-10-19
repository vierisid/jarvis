import { getWorkflowDb } from '../index';

export function workflowRemovalState(flowId: string): { generation: number; receipt_id: string | null } {
  return getWorkflowDb().query<{ generation: number; receipt_id: string | null }, [string]>(
    'SELECT generation, receipt_id FROM brief_workflow_slots WHERE flow_id = ?').get(flowId)
    ?? { generation: 0, receipt_id: null };
}
/** Capture before async trigger work; Undo does not reopen an older generation. */
export function workflowTriggerCurrent(flowId: string, versionId: string, generation: number): boolean {
  const db = getWorkflowDb();
  return !!db.query(`SELECT 1 FROM flow f JOIN brief_workflow_slots s ON s.flow_id = f.id
    WHERE f.id = ? AND f.status = 'ENABLED' AND s.receipt_id IS NULL AND s.generation = ?
      AND COALESCE(f.published_version_id, (SELECT version_id FROM brief_workflow_draft_selection WHERE flow_id = f.id)) = ?`
  ).get(flowId, generation, versionId);
}
/**
 * A workflow ever removed through F-20 keeps its history (the purge trigger
 * refuses the delete). Refuse before a legacy delete stops its runs, so a
 * refused delete never leaves the workflow in place with its runs killed.
 */
export function assertFlowDeletable(flowId: string): void {
  if (getWorkflowDb().query('SELECT 1 FROM brief_workflow_removals WHERE flow_id = ? LIMIT 1').get(flowId)) {
    throw new Error('workflow_history_retained');
  }
}

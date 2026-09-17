import { getWorkflowDb } from '../index';
import type { LLMMessage } from '../../../llm/provider';
import type { SubAgentPause } from '../../../agents/sub-agent-runner';
import type { PieceAgentDelegateResult } from '../../jarvis-pieces/types';

/**
 * What a delegated sub-agent needs to continue after its run parked on a
 * tool approval, bound to the run, step, loop position and version it
 * belongs to. Once the delegation finishes, the log is dropped and the
 * result kept, so a step the engine runs again answers from the record.
 */
export interface DelegationCheckpoint {
  id: string;
  runId: string;
  stepName: string;
  executionPath: Array<[string, number]>;
  versionDigest: string;
  roleId: string;
  goal: string;
  status: 'paused' | 'completed';
  messages: LLMMessage[];
  toolsUsed: string[];
  tokensUsed: { input: number; output: number };
  sequence: number;
  /** Present while paused: the call waiting on its approval. */
  pending?: SubAgentPause;
  /** Present once completed: what the step returned. */
  result?: PieceAgentDelegateResult;
  updatedAt: number;
}

export function getDelegation(id: string): DelegationCheckpoint | null {
  const row = getWorkflowDb().query('SELECT record FROM workflow_delegation WHERE id = ?').get(id) as { record: string } | null;
  return row ? JSON.parse(row.record) : null;
}

export function saveDelegation(checkpoint: DelegationCheckpoint): void {
  getWorkflowDb().run(`INSERT INTO workflow_delegation (id, run_id, status, record, updated_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, record=excluded.record, updated_at=excluded.updated_at`,
  [checkpoint.id, checkpoint.runId, checkpoint.status, JSON.stringify(checkpoint), checkpoint.updatedAt]);
}

export function listDelegations(runId: string): DelegationCheckpoint[] {
  const rows = getWorkflowDb().query('SELECT record FROM workflow_delegation WHERE run_id = ? ORDER BY rowid').all(runId) as Array<{ record: string }>;
  return rows.map(row => JSON.parse(row.record));
}

import { getWorkflowDb } from '../index';
import type { LLMMessage } from '../../../llm/provider';
import type { SubAgentPause } from '../../../agents/sub-agent-runner';
import type { PieceAgentDelegateResult } from '../../jarvis-pieces/types';

/**
 * What a delegated sub-agent needs to continue in a later process, bound to
 * the run, step, loop position and version it belongs to. `running` is the
 * state after each completed turn, `paused` the state at a governed call
 * waiting on its approval. Once the delegation finishes, the log is dropped
 * and the result kept, so a step the engine runs again answers from the
 * record. One row per step instance; deleted with the run.
 */
export interface DelegationCheckpoint {
  id: string;
  runId: string;
  stepName: string;
  executionPath: Array<[string, number]>;
  versionDigest: string;
  roleId: string;
  goal: string;
  status: 'running' | 'paused' | 'completed';
  messages: LLMMessage[];
  toolsUsed: string[];
  tokensUsed: { input: number; output: number };
  sequence: number;
  /** The next loop iteration to run when nothing is pending. */
  iteration: number;
  taint: string[];
  failedToolCalls: string[];
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

/** A run that will never resume has no use for its conversations. */
export function deleteDelegations(runId: string): number {
  return getWorkflowDb().run('DELETE FROM workflow_delegation WHERE run_id = ?', [runId]).changes;
}

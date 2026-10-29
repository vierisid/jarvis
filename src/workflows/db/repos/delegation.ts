import { getWorkflowDb } from '../index';
import type { LLMMessage } from '../../../llm/provider';
import type { SubAgentPause } from '../../../agents/sub-agent-runner';
import type { PieceAgentDelegateResult } from '../../jarvis-pieces/types';
import { digest } from '../../runtime/effect-context';

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

/** The checkpoint id of one step instance: the run, the step and its loop position. */
export function delegationId(runId: string, stepName: string, executionPath: Array<[string, number]>): string {
  return 'wfd_' + digest([runId, stepName, executionPath]);
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

/**
 * The most recently written checkpoint of a step in a run, at any loop
 * position: inside a loop the failing iteration is the last one to have run.
 */
export function latestDelegation(runId: string, stepName: string): DelegationCheckpoint | null {
  const rows = getWorkflowDb().query('SELECT record FROM workflow_delegation WHERE run_id = ? ORDER BY updated_at DESC, rowid DESC')
    .all(runId) as Array<{ record: string }>;
  for (const row of rows) {
    const checkpoint = JSON.parse(row.record) as DelegationCheckpoint;
    if (checkpoint.runId === runId && checkpoint.stepName === stepName) return checkpoint;
  }
  return null;
}

/** A run that will never resume has no use for its conversations. */
export function deleteDelegations(runId: string): number {
  return getWorkflowDb().run('DELETE FROM workflow_delegation WHERE run_id = ?', [runId]).changes;
}

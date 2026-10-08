/**
 * Q-08: what Pause and Kill mean for workflows (owner decision, 7 October).
 *
 * Pause holds. Nothing new starts or continues: the worker claims no job,
 * a trigger starts no run (a scheduled time is skipped and shown, a webhook
 * is told to retry later, a poll waits), and timers, approvals and resume
 * URLs wake nothing. A run already executing parks at its next step on a
 * HOLD waitpoint, which Resume releases (`releaseEmergencyHolds` in
 * `continuation.ts`). Queued and waiting work simply waits.
 *
 * Kill stops. On top of the hold, every unfinished run is stopped, saying
 * why, and every pending approval is denied (`daemon/index.ts`); Reset
 * starts nothing again.
 *
 * The state is the daemon's emergency controller, read through
 * `activeEmergencyState`; unwired (tests, tools) it is normal.
 */
import { activeEmergencyState } from '../../authority/emergency';
import { getWorkflowDb } from '../db';
import { cancelFlowRun } from '../db/repos/run-cancellation';
import { recordFire } from '../db/repos/trigger-fire';
import { createWaitpoint, type Waitpoint } from '../db/repos/waitpoint';

export const PAUSED_REASON = 'Jarvis is paused, so this waits until it is resumed.';
export const KILLED_REASON = 'Jarvis was stopped with Kill, so this did not run.';
export const KILLED_RUN_REASON = 'Jarvis was stopped with Kill, so this run was stopped.';

/** Why workflow work must not start or continue right now, or null. */
export function emergencyHold(): string | null {
  const state = activeEmergencyState();
  if (state === 'paused') return PAUSED_REASON;
  if (state === 'killed') return KILLED_REASON;
  return null;
}

/** What a person starting a run by hand is told while Jarvis is paused or stopped, or null. */
export function manualStartRefusal(): string | null {
  const held = emergencyHold();
  if (!held) return null;
  return held === PAUSED_REASON
    ? 'Jarvis is paused, so no workflow can start. Resume Jarvis to run it.'
    : 'Jarvis was stopped with Kill, so no workflow can start. Reset Jarvis to run it.';
}

/** Park a step reached while Jarvis is paused; the daemon releases it on Resume. */
export function holdStep(input: { runId: string; projectId: string; stepName: string }): Waitpoint {
  return createWaitpoint({ flowRunId: input.runId, projectId: input.projectId, stepName: input.stepName, type: 'HOLD' });
}

/**
 * Kill: stop every run that has not finished (queued, executing or waiting),
 * saying why, and tell an executing one to stop now. Returns how many were
 * stopped.
 */
export function stopUnfinishedRunsForKill(): number {
  const rows = getWorkflowDb().query<{ id: string; flow_id: string }, []>(
    `SELECT id, flow_id FROM flow_run WHERE status IN ('QUEUED', 'RUNNING', 'PAUSED')`,
  ).all();
  let stopped = 0;
  for (const row of rows) {
    try {
      if (!cancelFlowRun(row.id, { reason: KILLED_RUN_REASON, reasonLabel: 'Emergency stop' }).accepted) continue;
      recordFire({ flowId: row.flow_id, source: 'lifecycle', outcome: 'stopped', runId: row.id, detail: { reason: KILLED_RUN_REASON } });
      stopped++;
    } catch (error) {
      console.error(`[Workflow emergency] could not stop run ${row.id}:`, error);
    }
  }
  return stopped;
}

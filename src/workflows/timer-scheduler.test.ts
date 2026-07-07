import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { closeWorkflowDb, initWorkflowDb } from './db/index';
import { createFlow } from './db/repos/flow';
import { createDraftVersion } from './db/repos/flow-version';
import { createFlowRun, updateRun } from './db/repos/flow-run';
import { createWaitpoint, getWaitpoint } from './db/repos/waitpoint';
import { claimNextJob } from './db/repos/job-queue';
import { TimerWaitpointScheduler } from './timer-scheduler';

beforeEach(() => initWorkflowDb(':memory:'));
afterEach(() => closeWorkflowDb());

function pausedRun(): string {
  const flow = createFlow();
  const v = createDraftVersion({
    flowId: flow.id,
    displayName: 'v1',
    trigger: { name: 'trigger', type: 'EMPTY' },
  });
  return createFlowRun({ flowId: flow.id, flowVersionId: v.id, status: 'PAUSED' }).id;
}

function timerWaitpoint(runId: string, resumeIso: string) {
  return createWaitpoint({
    flowRunId: runId,
    projectId: 'p',
    stepName: 'wait',
    type: 'TIMER',
    resumeDateTime: resumeIso,
  });
}

describe('TimerWaitpointScheduler', () => {
  const sched = new TimerWaitpointScheduler();
  const now = Date.parse('2026-07-07T03:00:00Z');

  test('resumes a due TIMER waitpoint on a PAUSED run (enqueues one RESUME job)', () => {
    const runId = pausedRun();
    timerWaitpoint(runId, new Date(now - 1000).toISOString());
    expect(sched.tick(now)).toBe(1);
    const job = claimNextJob<{ executionType: string; runId: string }>();
    expect(job?.payload.executionType).toBe('RESUME');
    expect(job?.payload.runId).toBe(runId);
  });

  test('leaves a not-yet-due timer alone', () => {
    const runId = pausedRun();
    timerWaitpoint(runId, new Date(now + 60_000).toISOString());
    expect(sched.tick(now)).toBe(0);
    expect(claimNextJob()).toBeNull();
  });

  test('retires a due timer whose run is no longer PAUSED (no resume enqueued)', () => {
    const runId = pausedRun();
    updateRun(runId, { status: 'SUCCEEDED' });
    const wp = timerWaitpoint(runId, new Date(now - 1000).toISOString());
    expect(sched.tick(now)).toBe(0);
    expect(getWaitpoint(wp.id)?.resumedAt).not.toBeNull(); // retired, won't re-scan
    expect(claimNextJob()).toBeNull();
  });

  test('a second tick does not double-resume', () => {
    const runId = pausedRun();
    timerWaitpoint(runId, new Date(now - 1000).toISOString());
    expect(sched.tick(now)).toBe(1);
    expect(sched.tick(now)).toBe(0);
  });
});

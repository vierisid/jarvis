import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { closeWorkflowDb, initWorkflowDb } from './db/index';
import { createFlow } from './db/repos/flow';
import { createDraftVersion } from './db/repos/flow-version';
import { createFlowRun, getFlowRun, updateRun } from './db/repos/flow-run';
import { createWaitpoint, getWaitpoint, listWaitpointsByFlowRun } from './db/repos/waitpoint';
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

describe('a timer waitpoint always has a resume time', () => {
  test('createWaitpoint refuses a TIMER with none and stores nothing', () => {
    const runId = pausedRun();
    for (const resumeDateTime of [undefined, '', 'Invalid Date']) {
      expect(() => createWaitpoint({ flowRunId: runId, projectId: 'p', stepName: 'wait', type: 'TIMER', resumeDateTime })).toThrow('valid resume time');
    }
    expect(listWaitpointsByFlowRun(runId, false)).toHaveLength(0);
    // Other kinds of waitpoint are not timers.
    expect(createWaitpoint({ flowRunId: runId, projectId: 'p', stepName: 'ask', type: 'MANUAL' }).resumeDateTime).toBeNull();
  });
});

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

  for (const status of ['QUEUED', 'RUNNING'] as const) {
    test(`keeps a due timer while the run is ${status}, then resumes its published pause once`, () => {
      const runId = pausedRun();
      updateRun(runId, { status });
      const wp = timerWaitpoint(runId, new Date(now - 1000).toISOString());
      // The engine creates the waitpoint before uploading its PAUSED state.
      expect(sched.tick(now)).toBe(0);
      expect(getWaitpoint(wp.id)?.resumedAt).toBeNull();
      expect(claimNextJob()).toBeNull();

      updateRun(runId, { status: 'PAUSED' });
      expect(sched.tick(now)).toBe(1);
      expect(sched.tick(now)).toBe(0);
      expect(claimNextJob()?.flowRunId).toBe(runId);
      expect(claimNextJob()).toBeNull();
    });

    test(`100 older ${status} timers cannot starve a later PAUSED run`, () => {
      const deferred = Array.from({ length: 100 }, () => {
        const runId = pausedRun();
        updateRun(runId, { status });
        return { runId, wp: timerWaitpoint(runId, new Date(now - 2000).toISOString()) };
      });
      const readyRunId = pausedRun();
      timerWaitpoint(readyRunId, new Date(now - 1000).toISOString());

      expect(sched.tick(now)).toBe(1);
      expect(claimNextJob()?.flowRunId).toBe(readyRunId);
      expect(claimNextJob()).toBeNull();
      expect(sched.tick(now)).toBe(0);
      for (const { wp } of deferred) expect(getWaitpoint(wp.id)?.resumedAt).toBeNull();

      // Excluding these rows from this scan must not lose their future pause.
      const first = deferred[0]!;
      updateRun(first.runId, { status: 'PAUSED' });
      expect(sched.tick(now)).toBe(1);
      expect(claimNextJob()?.flowRunId).toBe(first.runId);
      expect(sched.tick(now)).toBe(0);
      expect(claimNextJob()).toBeNull();
      for (const { wp } of deferred.slice(1)) expect(getWaitpoint(wp.id)?.resumedAt).toBeNull();
    });
  }

  test('still bounds each scan to 100 eligible timers and reaches the remainder next tick', () => {
    const waits = Array.from({ length: 101 }, (_, index) =>
      timerWaitpoint(pausedRun(), new Date(now - 2000 + index).toISOString()),
    );
    expect(sched.tick(now)).toBe(100);
    expect(getWaitpoint(waits[100]!.id)?.resumedAt).toBeNull();
    expect(sched.tick(now)).toBe(1);
    expect(sched.tick(now)).toBe(0);
    for (const wp of waits) expect(getWaitpoint(wp.id)?.resumedAt).toBe(now);
  });

  test('retires a due timer whose run has succeeded (no resume enqueued)', () => {
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

describe('TimerWaitpointScheduler.afterJobSettled', () => {
  // A required child whose parent already ended: the child sweep stops it.
  function abandonedChild() {
    const flow = createFlow();
    const v = createDraftVersion({ flowId: flow.id, displayName: 'v1', trigger: { name: 'trigger', type: 'EMPTY' } });
    const parent = createFlowRun({ flowId: flow.id, flowVersionId: v.id, status: 'SUCCEEDED' });
    const child = createFlowRun({ flowId: flow.id, flowVersionId: v.id, status: 'RUNNING', parentRunId: parent.id, failParentOnFailure: true });
    const other = createFlowRun({ flowId: flow.id, flowVersionId: v.id, status: 'SUCCEEDED' });
    return { child: child.id, other: other.id };
  }
  const job = (flowRunId: string | null, jobType = 'RUN_FLOW', payload: Record<string, unknown> = {}) => ({ jobType, flowRunId, payload });

  test('a job of a run with no child and no child wait leaves the sweep to the poll', () => {
    const runs = abandonedChild();
    const sched = new TimerWaitpointScheduler();
    sched.afterJobSettled(job(runs.other));
    sched.afterJobSettled(job(runs.child, 'OTHER'));
    expect(getFlowRun(runs.child)?.status).toBe('RUNNING');
  });

  test('a job of a child runs the sweep', () => {
    const runs = abandonedChild();
    new TimerWaitpointScheduler().afterJobSettled(job(runs.child));
    expect(getFlowRun(runs.child)?.status).not.toBe('RUNNING');
  });

  test('a job that names its run only in the payload is matched by it; one naming none sweeps', () => {
    const runs = abandonedChild();
    const sched = new TimerWaitpointScheduler();
    sched.afterJobSettled(job(null, 'RUN_FLOW', { runId: runs.other }));
    expect(getFlowRun(runs.child)?.status).toBe('RUNNING');
    sched.afterJobSettled(job(null));
    expect(getFlowRun(runs.child)?.status).not.toBe('RUNNING');
  });
});

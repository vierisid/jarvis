import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { closeDb, getDb, initDatabase } from '../vault/schema.ts';
import { ensureWorkflowSchema, initWorkflowDb } from '../workflows/db/index.ts';
import * as goals from '../vault/goals.ts';
import { getCommitment, completeCommitment, createCommitment, getDueCommitments, getUpcoming, updateCommitmentDue } from '../vault/commitments.ts';
import { CommitmentExecutor } from '../daemon/commitment-executor.ts';
import { createFlow, deleteFlow, setPublishedVersion } from '../workflows/db/repos/flow.ts';
import { createDraftVersion, lockVersion } from '../workflows/db/repos/flow-version.ts';
import { getFlowRun, updateRun } from '../workflows/db/repos/flow-run.ts';
import { createWaitpoint, markWaitpointResumed } from '../workflows/db/repos/waitpoint.ts';
import { claimNextJob, completeJob, enqueue, getJob, queueStats, recoverOrphanedJobs } from '../workflows/db/repos/job-queue.ts';
import { Worker } from '../workflows/queue/worker.ts';
import { createRunFlowHandler } from '../workflows/runner/handler.ts';
import { EngineFlowExecutor } from '../workflows/runner/engine-runtime/engine-flow-executor.ts';
import type { EngineRuntime } from '../workflows/runner/engine-runtime/engine-runtime.ts';
import { createWorkflowRoutes } from '../workflows/api/routes.ts';
import { createApiRoutes, type ApiContext } from '../daemon/api-routes.ts';
import { DailyRhythm } from './rhythm.ts';
import { startWorkItemRun } from './workflow-bridge.ts';
import { checkWorkResult, configureWorkItem, createPlannedWork, createWorkItem, decideWorkItem, getWorkItem, listWorkItems, setWorkBlocker } from './work-items.ts';

let directory: string;
let dbPath: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'jarvis-work-items-'));
  dbPath = join(directory, 'test.db');
  initWorkflowDb(dbPath);
});
afterEach(() => { closeDb(); rmSync(directory, { recursive: true, force: true }); });

function restart() { closeDb(); initDatabase(dbPath); ensureWorkflowSchema(); }
function workflow() {
  const flow = createFlow();
  const version = lockVersion(createDraftVersion({ flowId: flow.id, displayName: 'Deliver report' }).id);
  setPublishedVersion(flow.id, version.id);
  return { flow, version };
}
function configuredWork() {
  const { flow, version } = workflow();
  const goal = goals.createGoal('Deliver report', 'task', { status: 'active' });
  const work = createWorkItem({ title: 'Prepare report', goalId: goal.id, mode: 'workflow', workflowId: flow.id, workflowVersionId: version.id, input: { report: 'weekly' } });
  return { flow, version, goal, work };
}
const accept = (id: string) => decideWorkItem(id, { outcome: 'accepted', reason: 'Prepare the weekly report' });
const result = { verdict: 'passed', summary: 'Report matches the source data', evidence: [{ ref: 'report://weekly', description: 'Totals checked against source' }] };

async function call(path: string, method: 'GET' | 'POST' | 'PATCH', url: string, body?: unknown) {
  const routes = createApiRoutes({ config: {}, agentService: {} } as ApiContext);
  const handler = (routes[path] as any)?.[method];
  expect(handler).toBeDefined();
  const res = await handler(new Request(`http://localhost${url}`, {
    method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
  }));
  return { status: res.status, body: await res.json() };
}
async function runRoute(flowId: string, body: unknown) {
  const req = new Request(`http://localhost/api/workflows/${flowId}/run`, { method: 'POST', body: JSON.stringify(body) }) as Request & { params: { id: string } };
  req.params = { id: flowId };
  const res = await createWorkflowRoutes()['/api/workflows/:id/run']!.POST!(req);
  return { status: res.status, body: await res.json() };
}

describe('Today work trace', () => {
  test('due dates never route linked proposals through legacy automatic execution or events', () => {
    const proposed = createWorkItem({ title: 'Undecided proposal' });
    const rejected = createWorkItem({ title: 'Rejected proposal' });
    decideWorkItem(rejected.id, { outcome: 'rejected', reason: 'Wrong priority' });
    const manual = createWorkItem({ title: 'Accepted manual work' }); accept(manual.id);
    const { flow, work } = configuredWork(); accept(work.id);
    startWorkItemRun(work.id, flow.id);
    for (const item of [proposed, rejected, manual, work]) {
      // The commitments.set_due tool and existing task API use this same setter.
      updateCommitmentDue(item.id, Date.now() - 1_000);
    }
    const upcoming = createWorkItem({ title: 'Upcoming proposal' });
    updateCommitmentDue(upcoming.id, Date.now() + 60_000);
    const ordinary = createCommitment('Ordinary due task', { when_due: Date.now() - 1_000 });
    restart();
    const executor = new CommitmentExecutor('passive');
    const published: string[] = [];
    executor.setEventBus({ publish: (_event: string, data: { id: string }) => published.push(data.id) } as any);
    executor.checkAndAnnounce();
    expect(executor.getPending().map(p => p.commitmentId)).toEqual([ordinary.id]);
    expect(published).toEqual([ordinary.id]);
    expect(getDueCommitments().map(c => c.id)).toContain(rejected.id);
    expect(getUpcoming().map(c => c.id)).toContain(upcoming.id);
    expect(getWorkItem(rejected.id).status).toBe('rejected');
    expect(queueStats().queued).toBe(1);
  });

  test('an exhausted execution interrupted by restart becomes a checked failure without rerunning', () => {
    const { flow, work } = configuredWork(); accept(work.id);
    const run = startWorkItemRun(work.id, flow.id);
    const job = claimNextJob()!;
    expect(job.flowRunId).toBe(run.id);
    expect(job.maxAttempts).toBe(1);
    // Durable state left by process death after claim and a partial execution.
    updateRun(run.id, { status: 'RUNNING', steps: { prepared: { output: 42 } }, stepsCount: 1 });
    restart();
    expect(recoverOrphanedJobs()).toBe(0);
    expect(getJob(job.id)?.status).toBe('FAILED');
    const recovered = getWorkItem(work.id);
    expect(recovered.status).toBe('failed');
    expect(recovered.blocker?.reason).toContain('interrupted');
    expect(recovered.run?.steps).toEqual({ prepared: { output: 42 } });
    expect(recovered.run?.finishTime).not.toBeNull();
    expect(startWorkItemRun(work.id, flow.id).id).toBe(run.id);
    expect(queueStats().queued).toBe(0);
    expect(() => checkWorkResult(work.id, result)).toThrow('failed run');
    checkWorkResult(work.id, { ...result, verdict: 'failed' });
    restart();
    expect(getWorkItem(work.id).resultCheck?.runSnapshot?.status).toBe('FAILED');
  });

  test('a crash between waitpoint creation and the pause upload leaves a checkable failure', async () => {
    const { flow, work, goal } = configuredWork(); accept(work.id);
    const run = startWorkItemRun(work.id, flow.id);
    claimNextJob();
    updateRun(run.id, { status: 'RUNNING', steps: { prepared: { output: 42 } }, stepsCount: 1 });
    // Waitpoint creation and the engine's PAUSED upload are separate writes.
    const waitpoint = createWaitpoint({ flowRunId: run.id, projectId: run.projectId, stepName: 'approve_report', type: 'MANUAL' });
    restart();
    recoverOrphanedJobs();
    expect(getWorkItem(work.id)).toMatchObject({ status: 'failed', blocker: { kind: 'run_failure', ref: run.id } });
    const resume = new Request(`http://localhost/api/webhooks/waitpoints/${waitpoint.id}`, { method: 'POST' }) as Request & { params: { id: string } };
    resume.params = { id: waitpoint.id };
    expect((await createWorkflowRoutes()['/api/webhooks/waitpoints/:id']!.POST!(resume)).status).toBe(409);
    expect((await call('/api/work-items/:id/result', 'POST', `/api/work-items/${work.id}/result`, { ...result, goalScore: 1 })).status).toBe(409);
    const checked = await call('/api/work-items/:id/result', 'POST', `/api/work-items/${work.id}/result`, { ...result, verdict: 'failed', summary: 'Interrupted before approval; report was not delivered' });
    expect(checked.status).toBe(200);
    restart();
    expect(getWorkItem(work.id).resultCheck?.runSnapshot).toMatchObject({ id: run.id, status: 'FAILED', steps: { prepared: { output: 42 } } });
    expect(goals.getProgressHistory(goal.id)).toEqual([]);
    expect(goals.getGoal(goal.id)?.score).toBe(0);
  });

  test.each([false, true])('cancelling queued work preserves its result after restart (resume: %s)', async (resume) => {
    const { flow, work, goal } = configuredWork(); accept(work.id);
    const run = startWorkItemRun(work.id, flow.id);
    if (resume) {
      const initial = claimNextJob()!;
      updateRun(run.id, { status: 'PAUSED', steps: { prepared: { output: 42 } }, stepsCount: 1 });
      const waitpoint = createWaitpoint({ flowRunId: run.id, projectId: run.projectId, stepName: 'approve', type: 'MANUAL' });
      completeJob(initial.id);
      const request = new Request(`http://localhost/api/webhooks/waitpoints/${waitpoint.id}`, { method: 'POST', body: '{}' }) as Request & { params: { id: string } };
      request.params = { id: waitpoint.id };
      expect((await createWorkflowRoutes()['/api/webhooks/waitpoints/:id']!.POST!(request)).status).toBe(202);
    }
    const req = new Request(`http://localhost/api/workflow-runs/${run.id}/cancel`, { method: 'POST' }) as Request & { params: { runId: string } };
    req.params = { runId: run.id };
    const cancelled = await createWorkflowRoutes()['/api/workflow-runs/:runId/cancel']!.POST!(req);
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toMatchObject({ jobCanceled: true });
    expect(getWorkItem(work.id)).toMatchObject({ status: 'failed', run: { id: run.id, status: 'STOPPED' }, blocker: { kind: 'run_failure' } });
    restart(); recoverOrphanedJobs();
    expect(claimNextJob()).toBeNull();
    expect(startWorkItemRun(work.id, flow.id).id).toBe(run.id);
    expect(queueStats().queued).toBe(0);
    expect(() => checkWorkResult(work.id, result)).toThrow('failed run');
    expect(checkWorkResult(work.id, { ...result, verdict: 'failed', summary: 'Cancelled before execution' }).status).toBe('failed');
    restart();
    expect(getWorkItem(work.id).resultCheck?.runSnapshot?.status).toBe('STOPPED');
    if (resume) expect(getWorkItem(work.id).resultCheck?.runSnapshot?.steps).toEqual({ prepared: { output: 42 } });
    expect(goals.getProgressHistory(goal.id)).toEqual([]);
  });

  test('startup repairs work left queued by older cancellation code', () => {
    const { flow, work } = configuredWork(); accept(work.id);
    const run = startWorkItemRun(work.id, flow.id);
    getDb().run("UPDATE workflow_job SET status = 'CANCELED' WHERE flow_run_id = ?", [run.id]);
    restart(); recoverOrphanedJobs();
    expect(getWorkItem(work.id)).toMatchObject({ status: 'failed', run: { id: run.id, status: 'STOPPED' } });
    expect(getFlowRun(run.id)?.finishTime).not.toBeNull();
    expect(claimNextJob()).toBeNull();
  });

  test('recovery repairs older stranded runs and preserves paused, finished, or still queued work', () => {
    for (const state of ['RUNNING', 'QUEUED', 'PAUSED', 'SUCCEEDED'] as const) {
      const { flow, work } = configuredWork(); accept(work.id);
      const run = startWorkItemRun(work.id, flow.id);
      const job = claimNextJob()!;
      updateRun(run.id, { status: state });
      // An earlier daemon already failed the queue entry without reconciling the run.
      getDb().run("UPDATE workflow_job SET status = 'FAILED', last_error = 'orphaned: max attempts exhausted' WHERE id = ?", [job.id]);
      recoverOrphanedJobs();
      expect(getFlowRun(run.id)?.status).toBe(['RUNNING', 'QUEUED'].includes(state) ? 'FAILED' : state);
    }
    const { flow, work } = configuredWork(); accept(work.id);
    const run = startWorkItemRun(work.id, flow.id);
    claimNextJob();
    updateRun(run.id, { status: 'RUNNING' });
    enqueue({ jobType: 'RUN_FLOW', payload: { runId: run.id, executionType: 'RESUME' }, flowRunId: run.id, maxAttempts: 1 });
    recoverOrphanedJobs();
    expect(getFlowRun(run.id)?.status).toBe('RUNNING');
    expect(queueStats().queued).toBe(1);
  });

  test.each([false, true])('recovery of an exhausted resume preserves an unresolved waitpoint: %s', (pausedAgain) => {
    const { flow, work } = configuredWork(); accept(work.id);
    const run = startWorkItemRun(work.id, flow.id);
    const initialJob = claimNextJob()!;
    const waitpoint = createWaitpoint({ flowRunId: run.id, projectId: run.projectId, stepName: 'approve', type: 'MANUAL' });
    updateRun(run.id, { status: 'PAUSED' });
    completeJob(initialJob.id);
    markWaitpointResumed(waitpoint.id);
    enqueue({ jobType: 'RUN_FLOW', payload: { runId: run.id, executionType: 'RESUME' }, flowRunId: run.id, maxAttempts: 1 });
    const resume = claimNextJob()!;
    // Death can happen just after claim, or after the engine reached another pause.
    const nextWaitpoint = pausedAgain ? createWaitpoint({ flowRunId: run.id, projectId: run.projectId, stepName: 'approve_again', type: 'MANUAL' }) : null;
    restart();
    recoverOrphanedJobs();
    expect(getJob(resume.id)?.status).toBe('FAILED');
    expect(getWorkItem(work.id)).toMatchObject(nextWaitpoint
      ? { status: 'blocked', blocker: { kind: 'waitpoint', ref: nextWaitpoint.id } }
      : { status: 'failed', blocker: { kind: 'run_failure' } });
    expect(queueStats().queued).toBe(0);
  });

  test('the production executor and handler preserve approval pauses through restart and resume', async () => {
    const { flow, work, goal } = configuredWork(); accept(work.id);
    const run = startWorkItemRun(work.id, flow.id);
    let waitpointId = '';
    // Only the external engine process is stubbed; queue, executor, handler and resume API are real.
    const runtime = { acquire: async () => ({
      async executeFlow(opts: { executionType?: string; resumePayload?: unknown }) {
        if (opts.executionType === 'RESUME') {
          expect(opts.resumePayload).toEqual({ approved: true });
          updateRun(run.id, { status: 'SUCCEEDED', steps: { report: { output: 42 } }, stepsCount: 1 });
        } else {
          waitpointId = createWaitpoint({ flowRunId: run.id, projectId: run.projectId, stepName: 'approve_report', type: 'MANUAL' }).id;
          updateRun(run.id, { status: 'PAUSED' });
        }
      },
      async release() {},
    }) } as unknown as EngineRuntime;
    const executor = new EngineFlowExecutor(runtime, { loaderBaseDir: directory, terminalTimeoutMs: 1_000, terminalPollIntervalMs: 10 });
    const worker = new Worker({ log: () => {}, handlers: { RUN_FLOW: createRunFlowHandler({ executor }) } });
    expect(await worker.drain()).toBe(1);
    restart();
    expect(getFlowRun(run.id)?.status).toBe('PAUSED');
    expect(getFlowRun(run.id)?.finishTime).toBeNull();
    expect(getWorkItem(work.id).blocker).toMatchObject({ kind: 'waitpoint', ref: waitpointId });
    expect((await call('/api/work-items/:id/result', 'POST', `/api/work-items/${work.id}/result`, { ...result, goalScore: 1 })).status).toBe(409);
    expect(() => checkWorkResult(work.id, { ...result, verdict: 'failed' })).toThrow('finished');
    expect(goals.getGoal(goal.id)?.score).toBe(0);
    const req = new Request(`http://localhost/api/webhooks/waitpoints/${waitpointId}`, { method: 'POST', body: JSON.stringify({ approved: true }) }) as Request & { params: { id: string } };
    req.params = { id: waitpointId };
    expect((await createWorkflowRoutes()['/api/webhooks/waitpoints/:id']!.POST!(req)).status).toBe(202);
    expect(await worker.drain()).toBe(1);
    expect(getWorkItem(work.id)).toMatchObject({ runId: run.id, status: 'needs_check' });
    expect(checkWorkResult(work.id, { ...result, goalScore: 1 }).status).toBe('verified');
  });

  test('an unresolved waitpoint blocks verification even if older code marked the run succeeded', async () => {
    const { flow, work, goal } = configuredWork(); accept(work.id);
    const run = startWorkItemRun(work.id, flow.id);
    const waitpoint = createWaitpoint({ flowRunId: run.id, projectId: run.projectId, stepName: 'approve_report', type: 'MANUAL' });
    updateRun(run.id, { status: 'SUCCEEDED', finishTime: Date.now() });
    restart();
    expect(getWorkItem(work.id)).toMatchObject({ status: 'blocked', blocker: { kind: 'waitpoint', ref: waitpoint.id } });
    expect((await call('/api/work-items/:id/result', 'POST', `/api/work-items/${work.id}/result`, { ...result, goalScore: 1 })).status).toBe(409);
    expect(() => checkWorkResult(work.id, { ...result, verdict: 'failed' })).toThrow('waitpoints');
    expect(goals.getProgressHistory(goal.id)).toEqual([]);
    expect(getWorkItem(work.id).resultCheck).toBeNull();
  });

  test('morning plan -> user decision -> queued execution -> checked goal progress survives restart', async () => {
    const { flow, version } = workflow();
    const goal = goals.createGoal('Deliver report', 'task', { status: 'active' });
    const rhythm = new DailyRhythm({ chatTier: async () => ({ content: JSON.stringify({
      focus_areas: ['Reports'], daily_actions: [{ title: 'Prepare report', goal_id: goal.id }],
    }) }) });
    const plan = await rhythm.runMorningPlan();
    const id = plan.workItems[0]!.id;
    expect(plan.checkIn.actions_planned).toEqual(['Prepare report']);
    expect(plan.checkIn.work_item_ids).toEqual([id]);
    expect(getCommitment(id)?.what).toBe('Prepare report');
    const configured = await call('/api/work-items/:id', 'PATCH', `/api/work-items/${id}`, { mode: 'workflow', workflowId: flow.id, workflowVersionId: version.id, input: { report: 'weekly' } });
    expect(configured.status).toBe(200);
    const decision = await call('/api/work-items/:id/decision', 'POST', `/api/work-items/${id}/decision`, { outcome: 'accepted', reason: 'Prepare the report' });
    expect(decision.status).toBe(200);
    const decisionId = decision.body.decision.id;
    // Publishing a newer definition must never change what was accepted.
    const newer = lockVersion(createDraftVersion({ flowId: flow.id, displayName: 'New report' }).id);
    setPublishedVersion(flow.id, newer.id);
    const started = await runRoute(flow.id, { workItemId: id });
    expect(started.status).toBe(202);
    expect(started.body.flowVersionId).toBe(version.id);
    expect(started.body.triggeredBy).toContain(decisionId);
    restart();
    expect(goals.getTodayCheckIn('morning_plan')?.work_item_ids).toEqual([id]);
    const retry = await runRoute(flow.id, { workItemId: id });
    expect(retry.body.id).toBe(started.body.id);
    expect(queueStats().queued).toBe(1);
    // Real queue and run handler, deterministic executor with no external effects.
    const worker = new Worker({ log: () => {}, handlers: { RUN_FLOW: createRunFlowHandler({ executor: {
      execute: async ctx => {
        expect(ctx.version.id).toBe(version.id);
        expect(ctx.payload).toEqual({ report: 'weekly' });
        return { steps: { report: { output: { total: 42, ref: 'report://weekly' } } }, stepsCount: 1 };
      },
    } }) } });
    expect(await worker.drain()).toBe(1);
    restart();
    expect(getWorkItem(id).status).toBe('needs_check');
    expect(goals.getGoal(goal.id)?.score).toBe(0);
    const checked = await call('/api/work-items/:id/result', 'POST', `/api/work-items/${id}/result`, { ...result, goalScore: 0.5 });
    expect(checked.status).toBe(200);
    restart();
    const today = await call('/api/work-items', 'GET', '/api/work-items?today=true');
    expect(today.status).toBe(200);
    expect(today.body).toHaveLength(1);
    expect(today.body[0]).toMatchObject({ id, planId: plan.checkIn.id, goalId: goal.id, status: 'verified', runId: started.body.id, workflowVersionId: version.id, decision: { id: decisionId } });
    const progress = goals.getProgressHistory(goal.id);
    expect(progress).toHaveLength(1);
    expect(today.body[0].resultCheck.goalProgressId).toBe(progress[0]!.id);
    expect(progress[0]!.source).toContain(today.body[0].resultCheck.id);
    expect(today.body[0].resultCheck.runSnapshot.steps.report.output.total).toBe(42);
    expect(getCommitment(id)?.status).toBe('completed');
    expect(goals.getGoal(goal.id)?.score).toBe(0.5);
    const child = Bun.spawnSync({
      cmd: [process.execPath, '-e', `
        import { initDatabase } from './src/vault/schema.ts';
        import { ensureWorkflowSchema } from './src/workflows/db/index.ts';
        import { getWorkItem } from './src/goals/work-items.ts';
        initDatabase(${JSON.stringify(dbPath)}, { quiet: true }); ensureWorkflowSchema();
        const w = getWorkItem(${JSON.stringify(id)});
        console.log(JSON.stringify({ id: w.id, decisionId: w.decision.id, runId: w.runId, status: w.status, checkId: w.resultCheck.id }));
      `],
      cwd: new URL('../../', import.meta.url).pathname,
    });
    expect(child.exitCode).toBe(0);
    expect(JSON.parse(new TextDecoder().decode(child.stdout))).toEqual({ id, decisionId, runId: started.body.id, status: 'verified', checkId: today.body[0].resultCheck.id });
    expect((await call('/api/work-items/:id/result', 'POST', `/api/work-items/${id}/result`, { ...result, goalScore: 0.7 })).status).toBe(409);
    expect(goals.getProgressHistory(goal.id)).toHaveLength(1);
  });

  test('legacy strings and fallback rhythms have stable work IDs without inventing goal links', async () => {
    initDatabase(':memory:'); // Goal rhythms do not depend on the workflow schema.
    const goal = goals.createGoal('Existing goal', 'task', { status: 'active' });
    const legacy = await new DailyRhythm({ chatTier: async () => ({ content: JSON.stringify({ daily_actions: ['Legacy action', { title: 'Unknown goal', goal_id: 'invented' }] }) }) }).runMorningPlan();
    expect(legacy.workItems.map(w => w.goalId)).toEqual([null, null]);
    expect(createPlannedWork(legacy.checkIn.id, [{ title: 'Legacy action', goalId: null }])[0]!.id).toBe(legacy.workItems[0]!.id);
    const fallback = await new DailyRhythm({ chatTier: async () => { throw new Error('offline'); } }).runMorningPlan();
    expect(fallback.workItems[0]?.goalId).toBe(goal.id);
    expect(fallback.dailyActions).toEqual(['Work on: Existing goal']);
    expect(goals.getRecentCheckIns('morning_plan').find(c => c.id === fallback.checkIn.id)?.work_item_ids).toEqual([fallback.workItems[0]!.id]);
  });

  test('pending and rejected proposals cannot start; run overrides and post-decision edits are rejected', async () => {
    const { flow, work } = configuredWork();
    expect((await runRoute(flow.id, { workItemId: work.id })).status).toBe(409);
    decideWorkItem(work.id, { outcome: 'rejected', reason: 'Wrong priority' });
    expect((await runRoute(flow.id, { workItemId: work.id })).status).toBe(409);
    expect(getWorkItem(work.id).status).toBe('rejected');
    expect(() => configureWorkItem(work.id, { input: {} })).toThrow('immutable');
    expect(() => checkWorkResult(work.id, result)).toThrow('Accept');
    const accepted = configuredWork(); accept(accepted.work.id);
    expect((await runRoute(accepted.flow.id, { workItemId: accepted.work.id, payload: { unexpected: true } })).status).toBe(400);
    expect((await runRoute(flow.id, { workItemId: accepted.work.id })).status).toBe(409);
    expect(queueStats().queued).toBe(0);
  });

  test('enqueue failure rolls back both the run and relation', () => {
    const { flow, work } = configuredWork(); accept(work.id);
    getDb().exec("CREATE TRIGGER reject_work_job BEFORE INSERT ON workflow_job BEGIN SELECT RAISE(ABORT, 'queue unavailable'); END");
    expect(() => startWorkItemRun(work.id, flow.id)).toThrow('queue unavailable');
    expect(getWorkItem(work.id).runId).toBeNull();
    expect(getDb().query('SELECT COUNT(*) AS n FROM flow_run').get()).toEqual({ n: 0 });
    expect(getCommitment(work.id)?.status).toBe('pending');
  });

  test('paused and failed runs expose durable blockers and cannot claim success', () => {
    const { flow, work } = configuredWork(); accept(work.id);
    const run = startWorkItemRun(work.id, flow.id);
    expect(() => checkWorkResult(work.id, result)).toThrow('finished');
    updateRun(run.id, { status: 'PAUSED' });
    const waitpoint = createWaitpoint({ flowRunId: run.id, projectId: run.projectId, stepName: 'approve_report', type: 'MANUAL' });
    restart();
    expect(getWorkItem(work.id).blocker).toMatchObject({ kind: 'waitpoint', ref: waitpoint.id });
    expect(() => checkWorkResult(work.id, result)).toThrow('finished');
    markWaitpointResumed(waitpoint.id);
    updateRun(run.id, { status: 'FAILED', failedStep: { name: 'report', displayName: 'Report', errorMessage: 'Missing source' }, finishTime: Date.now() });
    restart();
    expect(getWorkItem(work.id).blocker).toMatchObject({ kind: 'run_failure', ref: run.id, reason: 'Missing source' });
    expect(() => checkWorkResult(work.id, result)).toThrow('failed run');
    expect(checkWorkResult(work.id, { ...result, verdict: 'failed' }).status).toBe('failed');
  });

  test('manual work requires a decision and explicit evidence, and legacy task completion is not verification', () => {
    const work = createWorkItem({ title: 'Review the report' });
    expect(() => checkWorkResult(work.id, result)).toThrow('Accept');
    const decision = accept(work.id).decision;
    expect(accept(work.id).decision?.id).toBe(decision?.id);
    setWorkBlocker(work.id, { reason: 'Waiting for source data' });
    restart();
    expect(getWorkItem(work.id).status).toBe('blocked');
    expect(() => checkWorkResult(work.id, result)).toThrow('unblock');
    setWorkBlocker(work.id, { reason: null });
    completeCommitment(work.id, 'Done');
    expect(getWorkItem(work.id).status).toBe('ready');
    expect(() => checkWorkResult(work.id, { ...result, evidence: [] })).toThrow('evidence');
    expect(checkWorkResult(work.id, result).status).toBe('verified');
  });

  test('validated configuration rejects missing goals and mutable or unrelated workflow versions', () => {
    const { flow, version } = workflow();
    const draft = createDraftVersion({ flowId: flow.id, displayName: 'Draft' });
    expect(() => createWorkItem({ title: 'Invalid', goalId: 'missing' })).toThrow('goalId');
    expect(() => createWorkItem({ title: 'Invalid', mode: 'workflow', workflowId: flow.id, workflowVersionId: draft.id })).toThrow('locked');
    expect(() => createWorkItem({ title: 'Invalid', mode: 'workflow', workflowId: createFlow().id, workflowVersionId: version.id })).toThrow('belonging');
    expect(listWorkItems()).toEqual([]);
    expect(getDb().query('SELECT COUNT(*) AS n FROM commitments').get()).toEqual({ n: 0 });
  });

  test('deleted run history preserves the decision and checked evidence snapshot', () => {
    const { flow, work } = configuredWork(); accept(work.id);
    const run = startWorkItemRun(work.id, flow.id);
    updateRun(run.id, { status: 'SUCCEEDED', steps: { report: { output: 42 } }, finishTime: Date.now() });
    checkWorkResult(work.id, result);
    deleteFlow(flow.id);
    restart();
    const recovered = getWorkItem(work.id);
    expect(recovered.run).toBeNull();
    expect(recovered.runId).toBe(run.id);
    expect(recovered.status).toBe('verified');
    expect(recovered.resultCheck?.runSnapshot?.steps).toEqual({ report: { output: 42 } });
  });

  test('Today excludes earlier work and legacy daily-action goals retain their API contract', async () => {
    const old = createWorkItem({ title: 'Yesterday' });
    const start = new Date(); start.setHours(0, 0, 0, 0);
    getDb().run('UPDATE commitments SET created_at = ? WHERE id = ?', [start.getTime() - 1, old.id]);
    const work = createWorkItem({ title: 'Today' });
    expect(listWorkItems({ today: true }).map(w => w.id)).toEqual([work.id]);
    const goal = goals.createGoal('Independent daily action', 'daily_action', { status: 'active' });
    const response = await call('/api/goals/daily-actions', 'GET', '/api/goals/daily-actions');
    expect(response.body[0].id).toBe(goal.id);
    expect(response.body[0].level).toBe('daily_action');
    expect((await call('/api/work-items/:id', 'GET', '/api/work-items/missing')).status).toBe(404);
    expect((await call('/api/work-items', 'POST', '/api/work-items', { title: '' })).status).toBe(400);
  });

  test('upgrades existing text-only plans once, preserving duplicate titles as separate actions', () => {
    const plan = goals.createCheckIn('morning_plan', 'Old plan', [], ['Review report', 'Review report']);
    expect(plan.work_item_ids).toEqual([]);
    restart();
    const recovered = listWorkItems({ planId: plan.id });
    expect(recovered).toHaveLength(2);
    expect(recovered[0]!.id).not.toBe(recovered[1]!.id);
    expect(recovered.map(w => w.actionIndex)).toEqual([0, 1]);
    expect(recovered.every(w => w.goalId === null && w.decision === null && w.status === 'proposed')).toBe(true);
    restart();
    expect(listWorkItems({ planId: plan.id }).map(w => w.id)).toEqual(recovered.map(w => w.id));
    expect(goals.getTodayCheckIn('morning_plan')?.work_item_ids).toEqual(recovered.map(w => w.id));
  });
});

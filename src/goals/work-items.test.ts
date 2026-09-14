import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { closeDb, getDb, initDatabase } from '../vault/schema.ts';
import { ensureWorkflowSchema, initWorkflowDb } from '../workflows/db/index.ts';
import * as goals from '../vault/goals.ts';
import { getCommitment, completeCommitment } from '../vault/commitments.ts';
import { createFlow, deleteFlow, setPublishedVersion } from '../workflows/db/repos/flow.ts';
import { createDraftVersion, lockVersion } from '../workflows/db/repos/flow-version.ts';
import { updateRun } from '../workflows/db/repos/flow-run.ts';
import { createWaitpoint, markWaitpointResumed } from '../workflows/db/repos/waitpoint.ts';
import { queueStats } from '../workflows/db/repos/job-queue.ts';
import { Worker } from '../workflows/queue/worker.ts';
import { createRunFlowHandler } from '../workflows/runner/handler.ts';
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

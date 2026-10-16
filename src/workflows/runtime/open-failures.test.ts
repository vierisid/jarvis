import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { closeWorkflowDb, DEFAULT_IDS, getWorkflowDb, initWorkflowDb } from '../db';
import { createWorkflowRoutes } from '../api/routes';
import { createFlow } from '../db/repos/flow';
import { createDraftVersion } from '../db/repos/flow-version';
import { createFlowRun, updateRun, type FlowRun } from '../db/repos/flow-run';
import { saveWorkflowEffect, type WorkflowEffect } from '../db/repos/workflow-effect';
import { cancelFlowRun } from '../db/repos/run-cancellation';
import { decideRunRecovery, getRunRecovery } from './recovery';
import { dismissFailures, FINISHED_RUNS_SQL, listOpenFailures, UNCONFIRMED_NOTICES_SQL } from './open-failures';
import { chatErrorPayload, recordChatFailure } from '../../failures/chat';

beforeEach(() => { initWorkflowDb(':memory:'); });
afterEach(() => { closeWorkflowDb(); });

function workflow(projectId?: string) {
  const flow = createFlow({ projectId });
  const version = createDraftVersion({ flowId: flow.id, displayName: 'Invoices', trigger: {
    name: 'trigger', type: 'EMPTY', nextAction: { name: 'notify', type: 'PIECE', displayName: 'Tell me',
      settings: { pieceName: '@jarvispieces/piece-jarvis-notify', pieceVersion: '0.0.1', actionName: 'notify', input: {} },
      nextAction: { name: 'code', type: 'CODE', displayName: 'Post to the ledger', settings: { input: {} } } },
  } });
  let clock = Date.now() - 60_000;
  const run = (status: FlowRun['status'], failedStep: FlowRun['failedStep'] = null) => {
    const created = createFlowRun({ flowId: flow.id, flowVersionId: version.id, status: 'RUNNING' });
    // Distinct creation times, so "later" is well defined.
    getWorkflowDb().run('UPDATE flow_run SET created = ? WHERE id = ?', [clock += 1000, created.id]);
    return updateRun(created.id, { status, failedStep, finishTime: clock })!;
  };
  const effect = (r: FlowRun, stepName: string, fields: Partial<WorkflowEffect>) => saveWorkflowEffect({
    id: `wfe_${r.id}_${stepName}`, runId: r.id, projectId: r.projectId, flowId: flow.id, versionId: version.id, versionDigest: 'v',
    stepName, executionPath: [], route: 'tool', toolName: 't', actionCategory: 'write_data', requestDigest: 'r', arguments: {},
    target: {}, provenance: {}, decision: 'allowed', reason: '', status: 'succeeded', approvalId: null, waitpointId: null,
    createdAt: clock, finishedAt: clock, ...fields });
  return { flow, run, effect };
}

const denied = { status: 'blocked' as const, code: 'APPROVAL_DENIED', message: 'denied', effect: 'not_started' as const };
const uncertain = { status: 'unknown' as const, code: 'DISPATCH_UNCERTAIN', message: 'lost', effect: 'may_have_occurred' as const };

describe('Waiting on you: open failures (Q-19)', () => {
  test('a failed run shows once, with the sentence Runs shows and its workflow', () => {
    const w = workflow();
    const r = w.run('FAILED', { name: 'code', displayName: 'Post to the ledger' });
    w.effect(r, 'code', { status: 'blocked', outcome: denied });
    const [row, ...rest] = listOpenFailures();
    expect(rest).toEqual([]);
    expect(row).toMatchObject({ source: 'run', title: 'Invoices', runId: r.id, repeats: 0,
      failure: { category: 'approval_denied', headline: 'The step "Post to the ledger" did not run: its approval was denied.' } });
  });

  test('repeats of a failure that changed nothing share one row, and one dismissal clears them', () => {
    const w = workflow();
    for (let i = 0; i < 3; i++) w.effect(w.run('FAILED', { name: 'code', displayName: 'Post to the ledger' }), 'code', { status: 'blocked', outcome: denied });
    const rows = listOpenFailures();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.repeats).toBe(2);
    expect(dismissFailures(rows[0]!.keys)).toBe(3);
    expect(listOpenFailures()).toEqual([]);
  });

  test('a later successful run clears a failure that changed nothing', () => {
    const w = workflow();
    w.effect(w.run('FAILED', { name: 'code', displayName: 'Post to the ledger' }), 'code', { status: 'blocked', outcome: denied });
    w.run('SUCCEEDED');
    expect(listOpenFailures()).toEqual([]);
  });

  test('a failure that may have taken effect stays until its recovery is inspected', async () => {
    const w = workflow();
    const r = w.run('FAILED', { name: 'code', displayName: 'Post to the ledger' });
    w.effect(r, 'code', { status: 'unknown', outcome: uncertain });
    w.run('SUCCEEDED');
    expect(listOpenFailures().map(row => row.failure.effect)).toEqual(['unknown']);
    await decideRunRecovery(r.id, { requestId: 'checked-1', revision: getRunRecovery(r.id)!.revision, action: 'inspect', note: 'Checked the ledger' });
    expect(listOpenFailures()).toEqual([]);
  });

  test('a run stopped with nothing in flight waits on nobody', () => {
    const w = workflow();
    const queued = createFlowRun({ flowId: w.flow.id, flowVersionId: w.run('SUCCEEDED').flowVersionId, status: 'QUEUED' });
    cancelFlowRun(queued.id);
    expect(listOpenFailures()).toEqual([]);
  });

  test('a message a channel did not confirm shows as possibly not arrived', () => {
    const w = workflow();
    const r = w.run('SUCCEEDED');
    w.effect(r, 'notify', { route: 'notify', result: { delivered: ['dashboard'], failed: [], unknown: [{ channel: 'telegram', error: 'timed out' }] } });
    expect(listOpenFailures()).toMatchObject([{ source: 'delivery', failure: { category: 'uncertain_effect', effect: 'unknown',
      headline: 'The message from step "Tell me" may not have arrived.', outcome: 'Sent on the dashboard. Telegram did not confirm it.' } }]);
  });

  test('a chat turn that may have acted waits until dismissed; one that changed nothing is not kept', () => {
    const acted = chatErrorPayload({ source: 'provider', code: 'rate_limit', message: '429' }, { requestId: 'req-1', toolsRan: true }).failure;
    const quiet = chatErrorPayload({ source: 'provider', code: 'rate_limit', message: '429' }, { requestId: 'req-2' }).failure;
    expect(recordChatFailure(acted)).toBe(true);
    expect(recordChatFailure(acted)).toBe(false);
    expect(recordChatFailure(quiet)).toBe(false);
    expect(listOpenFailures()).toMatchObject([{ source: 'chat', title: 'Chat', keys: [acted.key],
      failure: { headline: 'Your request failed: the AI provider is rate limiting requests.', effect: 'unknown' } }]);
    dismissFailures([acted.key]);
    expect(listOpenFailures()).toEqual([]);
  });

  // Owner decision: until resolved or dismissed. Nothing ages out once indexed.
  test('a failure waits however old it gets; malformed dismissals are ignored', () => {
    const w = workflow();
    w.effect(w.run('FAILED', { name: 'code', displayName: 'Post to the ledger' }), 'code', { status: 'blocked', outcome: denied });
    expect(listOpenFailures()).toHaveLength(1);
    expect(listOpenFailures(Date.now() + 60 * 86_400_000)).toHaveLength(1);
    expect(dismissFailures(['not-a-key', 42, null])).toBe(0);
    expect(dismissFailures('nope')).toBe(0);
    expect(listOpenFailures()).toHaveLength(1);
  });

  test('the very first scan looks back a week; later runs are indexed as they finish', () => {
    const w = workflow();
    const old = w.run('FAILED', { name: 'code', displayName: 'Post to the ledger' });
    w.effect(old, 'code', { status: 'unknown', outcome: uncertain });
    getWorkflowDb().run('UPDATE flow_run SET updated = ? WHERE id = ?', [Date.now() - 8 * 86_400_000, old.id]);
    expect(listOpenFailures()).toEqual([]);
    const fresh = w.run('FAILED', { name: 'code', displayName: 'Post to the ledger' });
    w.effect(fresh, 'code', { status: 'unknown', outcome: uncertain });
    expect(listOpenFailures().map(row => row.runId)).toEqual([fresh.id]);
  });

  // Review C6: one workflow failing all day cannot push the others out.
  test('a noisy workflow keeps one row per kind of failure, and others stay visible', () => {
    const noisy = workflow(), quiet = workflow();
    getWorkflowDb().transaction(() => {
      for (let i = 0; i < 300; i++) noisy.effect(noisy.run('FAILED', { name: 'code', displayName: 'Post to the ledger' }), 'code', { status: 'blocked', outcome: denied });
    })();
    const lone = quiet.run('FAILED', { name: 'code', displayName: 'Post to the ledger' });
    quiet.effect(lone, 'code', { status: 'unknown', outcome: uncertain });
    const rows = listOpenFailures();
    expect(new Map(rows.map(row => [row.flowId, row.repeats]))).toEqual(new Map([[quiet.flow.id, 0], [noisy.flow.id, 299]]));
  });

  // Review P1, P2: a poll reads what finished since the last one and what is still open, not history.
  test('settled failures leave the index, so later polls never read them again', () => {
    const w = workflow();
    w.effect(w.run('FAILED', { name: 'code', displayName: 'Post to the ledger' }), 'code', { status: 'blocked', outcome: denied });
    expect(listOpenFailures()).toHaveLength(1);
    expect(getWorkflowDb().query('SELECT COUNT(*) AS n FROM open_failure').get()).toEqual({ n: 1 });
    w.run('SUCCEEDED');
    expect(listOpenFailures()).toEqual([]);
    expect(getWorkflowDb().query('SELECT COUNT(*) AS n FROM open_failure').get()).toEqual({ n: 0 });
  });

  test('the finished-run scan and the delivery lookup use indexes, never a full scan of effects', () => {
    const plan = (sql: string, ...params: Array<string | number>) => (getWorkflowDb().query(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as
      Array<{ detail: string }>).map(r => r.detail).join(' | ');
    const scan = plan(FINISHED_RUNS_SQL, 0, 5);
    expect(scan).toContain('idx_flow_run_updated');
    expect(scan).not.toContain('TEMP B-TREE');
    expect(plan(UNCONFIRMED_NOTICES_SQL, 'r')).toContain('idx_workflow_effect_run (run_id=?)');
  });
});


describe('project-scoped failure routes after the Q-19 rebase', () => {
  const list = async (projectId: string) => {
    const routes = createWorkflowRoutes({ callerProjectId: () => projectId });
    const response = await routes['/api/failures/open']!.GET!(new Request('http://fixture.test/api/failures/open'));
    expect(response.status).toBe(200);
    return await response.json() as Array<{ runId: string; source: string; keys: string[] }>;
  };
  const dismiss = async (projectId: string, keys: string[]) => {
    const routes = createWorkflowRoutes({ callerProjectId: () => projectId });
    const response = await routes['/api/failures/dismiss']!.POST!(new Request('http://fixture.test/api/failures/dismiss', {
      method: 'POST', body: JSON.stringify({ keys }),
    }));
    expect(response.status).toBe(200);
    return await response.json() as { dismissed: number };
  };

  test('failure and delivery lists follow flow ownership and retain the run pagination envelope', async () => {
    const project = 'failure-private';
    const own = workflow(project), foreign = workflow(DEFAULT_IDS.project);
    const run = own.run('FAILED', { name: 'code', displayName: 'Post to the ledger' });
    own.effect(run, 'code', { status: 'blocked', outcome: denied });
    const delivered = own.run('SUCCEEDED');
    own.effect(delivered, 'notify', { route: 'notify', result: { delivered: ['dashboard'], failed: [], unknown: ['telegram'] } });
    // Use an uncertain failure so the later successful run cannot clear it.
    own.effect(run, 'code', { status: 'unknown', outcome: uncertain });
    const other = foreign.run('FAILED', { name: 'code', displayName: 'Foreign failure' });
    foreign.effect(other, 'code', { status: 'unknown', outcome: uncertain });
    const otherDelivery = foreign.run('SUCCEEDED');
    foreign.effect(otherDelivery, 'notify', { route: 'notify', result: { delivered: ['dashboard'], failed: [], unknown: ['telegram'] } });
    getWorkflowDb().run('UPDATE flow_run SET project_id = ?', [DEFAULT_IDS.project]);
    expect(new Set((await list(project)).map(r => r.runId))).toEqual(new Set([run.id, delivered.id]));
    expect(new Set((await list(DEFAULT_IDS.project)).map(r => r.runId))).toEqual(new Set([other.id, otherDelivery.id]));
    const routes = createWorkflowRoutes({ callerProjectId: () => project });
    const request = Object.assign(new Request(`http://fixture.test/api/workflows/${own.flow.id}/runs?limit=1&offset=1`), { params: { id: own.flow.id } });
    const response = await routes['/api/workflows/:id/runs']!.GET!(request);
    expect(response.status).toBe(200);
    const page = await response.json() as { items: Array<{ id: string; failure: unknown }>; nextOffset: number | null };
    expect(page.nextOffset).toBe(2);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ id: run.id, failure: { category: 'uncertain_effect' } });
  });

  test("one project cannot dismiss another project's workflow failures, even by a known key", async () => {
    const project = 'failure-private';
    const own = workflow(project), foreign = workflow(DEFAULT_IDS.project);
    for (const w of [own, foreign]) w.effect(w.run('FAILED', { name: 'code', displayName: 'Post to the ledger' }), 'code', { status: 'blocked', outcome: denied });
    const all = listOpenFailures();
    const ownKeys = all.find(row => row.flowId === own.flow.id)!.keys;
    const otherKeys = all.find(row => row.flowId === foreign.flow.id)!.keys;
    expect(await dismiss(DEFAULT_IDS.project, ownKeys)).toEqual({ dismissed: 0 });
    expect(getWorkflowDb().query('SELECT COUNT(*) AS count FROM failure_dismissal').get()).toEqual({ count: 0 });
    expect(await dismiss(project, [...ownKeys, ...otherKeys, 'a'.repeat(32)])).toEqual({ dismissed: ownKeys.length });
    expect((await list(project))).toEqual([]);
    expect((await list(DEFAULT_IDS.project))).toHaveLength(1);
    expect(getWorkflowDb().query('SELECT key FROM failure_dismissal').all()).toEqual(ownKeys.map(key => ({ key })));
    expect(await dismiss(project, otherKeys)).toEqual({ dismissed: 0 });
    expect(getWorkflowDb().query('SELECT COUNT(*) AS count FROM workflow_job').get()).toEqual({ count: 0 });
  });

  test('foreign rows cannot consume the failure or delivery query limits', async () => {
    const project = 'failure-private';
    const own = workflow(project), foreign = workflow(DEFAULT_IDS.project);
    const ownRun = own.run('FAILED', { name: 'code', displayName: 'Own failure' });
    own.effect(ownRun, 'code', { status: 'unknown', outcome: uncertain });
    const ownDelivery = own.run('SUCCEEDED');
    own.effect(ownDelivery, 'notify', { route: 'notify', result: { delivered: [], failed: [], unknown: ['telegram'] } });
    getWorkflowDb().transaction(() => {
      for (let i = 0; i < 205; i++) foreign.run('FAILED', { name: 'code', displayName: 'Other failure' });
      for (let i = 0; i < 105; i++) foreign.effect(foreign.run('SUCCEEDED'), 'notify', {
        route: 'notify', result: { delivered: [], failed: [], unknown: ['telegram'] },
      });
      getWorkflowDb().run('UPDATE flow_run SET created = ? WHERE flow_id = ?', [Date.now(), foreign.flow.id]);
    })();
    expect(new Set((await list(project)).map(r => r.runId))).toEqual(new Set([ownRun.id, ownDelivery.id]));
  });
});

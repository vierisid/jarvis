import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { closeWorkflowDb, DEFAULT_IDS, getWorkflowDb, initWorkflowDb } from '../db';
import { createFlow } from '../db/repos/flow';
import { createDraftVersion } from '../db/repos/flow-version';
import { createFlowRun, updateRun } from '../db/repos/flow-run';
import { BriefCapabilities } from '../../brief/capabilities';
import { HUMAN_INPUT_PIECE, HUMAN_INPUT_UNAVAILABLE_MESSAGE } from '../runtime/human-input-contract';
import { getHumanInput, requestHumanInput } from '../runtime/human-input';
import { ActionOutcomeError } from '../../actions/action-outcome';
import { createWorkflowRoutes } from './routes';

/**
 * #1266 follow-up (owner, 2026-11-06): workflow input requests are answered in
 * Needs you, the Brief decisions feature. The dashboard hides them with
 * decisions off, so their routes refuse then too, as `/api/brief/decisions`
 * does: 501 `unsupported` with no provider, 503 `unavailable` when it is off
 * or not ready.
 */
beforeEach(() => { initWorkflowDb(':memory:'); });
afterEach(() => { closeWorkflowDb(); });

const provider = (state: 'ready' | 'loading' = 'ready') => ({ readiness: () => state });
const CAPS = {
  absent: undefined,
  unregistered: new BriefCapabilities([], ['decisions']),
  disabled: new BriefCapabilities([{ id: 'decisions', provider: provider() }], []),
  loading: new BriefCapabilities([{ id: 'decisions', provider: provider('loading') }], ['decisions']),
  on: new BriefCapabilities([{ id: 'decisions', provider: provider() }], ['decisions']),
};

/** One run of a flow whose step asks for approval, asking. */
async function ask(opts: { unavailable?: string | null; flowId?: string; key?: string } = {}) {
  const flow = opts.flowId ? { id: opts.flowId } : createFlow({});
  const version = createDraftVersion({ flowId: flow.id, displayName: 'Check-ins', trigger: { name: 'trigger', type: 'EMPTY',
    nextAction: { name: 'ask', type: 'PIECE', displayName: 'ask', settings: { pieceName: HUMAN_INPUT_PIECE, pieceVersion: '0.0.1', actionName: 'request_approval',
      input: { title: 'Approve', prompt: 'Approve this?', requestKey: 'k', timeoutHours: 1 } } } } as never });
  const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id, status: 'RUNNING' });
  const call = () => requestHumanInput({ title: 'Approve', prompt: 'Approve this?', requestKey: opts.key ?? 'k', timeoutHours: 1 },
    { runId: run.id, projectId: DEFAULT_IDS.project, stepName: 'ask', executionPath: [] }, Date.now(), { unavailable: opts.unavailable ?? null });
  const reply = await call() as { requestId: string };
  return { requestId: reply.requestId, runId: run.id, flowId: flow.id, again: call };
}

/** Every route of the family, each called as the dashboard calls it. */
function calls(routes: ReturnType<typeof createWorkflowRoutes>, id: string) {
  const req = (path: string, init?: RequestInit) => Object.assign(new Request(`http://localhost${path}`, init), { params: { id } });
  const answer = JSON.stringify({ decision: 'approve', generation: 0 });
  return {
    list: () => routes['/api/workflow-inputs']!.GET!(req('/api/workflow-inputs')),
    history: () => routes['/api/workflow-inputs/history']!.GET!(req('/api/workflow-inputs/history')),
    read: () => routes['/api/workflow-inputs/:id']!.GET!(req(`/api/workflow-inputs/${id}`)),
    answer: () => routes['/api/workflow-inputs/:id']!.POST!(req(`/api/workflow-inputs/${id}`, { method: 'POST', body: answer })),
    dismiss: () => routes['/api/workflow-inputs/:id/dismiss']!.POST!(req(`/api/workflow-inputs/${id}/dismiss`, { method: 'POST', body: '{}' })),
  };
}

describe('workflow input routes follow the decisions capability (#1266)', () => {
  for (const [name, status, code] of [['absent', 501, 'unsupported'], ['unregistered', 501, 'unsupported'],
    ['disabled', 503, 'unavailable'], ['loading', 503, 'unavailable']] as const) {
    test(`with decisions ${name}, every route refuses (${status} ${code}) and the request stays unanswered`, async () => {
      const { requestId: id } = await ask();
      const c = calls(createWorkflowRoutes({ briefCapabilities: CAPS[name] }), id);
      for (const call of Object.values(c)) {
        const response = await call();
        expect(response.status).toBe(status);
        expect(await response.json()).toEqual({ error: status === 501 ? 'Decisions are unsupported' : 'Decisions are unavailable or disabled', code });
      }
      expect(getHumanInput(DEFAULT_IDS.project, id)?.status).toBe('pending');
    });
  }

  test('with decisions on, the routes read and answer as before', async () => {
    const { requestId: id } = await ask();
    const c = calls(createWorkflowRoutes({ briefCapabilities: CAPS.on }), id);
    expect((await (await c.list()).json()).requests.map((r: { id: string }) => r.id)).toEqual([id]);
    expect((await c.read()).status).toBe(200);
    expect((await c.history()).status).toBe(200);
    expect((await c.answer()).status).toBe(200);
    expect(getHumanInput(DEFAULT_IDS.project, id)?.status).toBe('approved');
  });
});

describe('asking for input (#1266)', () => {
  test('with Needs you off, a step that would create a request fails at once, typed, and creates none', async () => {
    const error = await ask({ unavailable: HUMAN_INPUT_UNAVAILABLE_MESSAGE }).then(() => null, (e) => e);
    expect(error).toBeInstanceOf(ActionOutcomeError);
    expect((error as ActionOutcomeError).outcome).toEqual({ status: 'blocked', code: 'HUMAN_INPUT_UNAVAILABLE', effect: 'not_started', message: HUMAN_INPUT_UNAVAILABLE_MESSAGE });
    expect(getWorkflowDb().query('SELECT COUNT(*) AS n FROM workflow_human_request').get()).toEqual({ n: 0 });
  });

  test('a request created while Needs you was on is still read once it is off', async () => {
    const asked = await ask();
    const again = await asked.again.call(null) as { requestId: string };
    expect(again.requestId).toBe(asked.requestId);
    const offAgain = await requestHumanInput({ title: 'Approve', prompt: 'Approve this?', requestKey: 'k', timeoutHours: 1 },
      { runId: asked.runId, projectId: DEFAULT_IDS.project, stepName: 'ask', executionPath: [] }, Date.now(), { unavailable: HUMAN_INPUT_UNAVAILABLE_MESSAGE }) as { requestId: string };
    expect(offAgain.requestId).toBe(asked.requestId);
  });

  test('the limit counts only requests someone can still answer', async () => {
    const first = await ask({ key: 'k0' });
    const second = (await ask({ flowId: first.flowId, key: 'k1' })).requestId;
    for (let i = 2; i < 20; i++) await ask({ flowId: first.flowId, key: `k${i}` });
    const refused = await ask({ flowId: first.flowId, key: 'k20' }).then(() => null, (e) => e);
    expect((refused as ActionOutcomeError).outcome).toMatchObject({ code: 'HUMAN_INPUT_LIMIT', effect: 'not_started' });
    // The run waiting on one of them ended: that request no longer counts, before any sweep closes it.
    updateRun(first.runId, { status: 'FAILED', finishTime: Date.now() });
    expect((await ask({ flowId: first.flowId, key: 'k21' })).requestId).toBeString();
    expect((await ask({ flowId: first.flowId, key: 'k22' }).then(() => null, (e) => e) as ActionOutcomeError).outcome.code).toBe('HUMAN_INPUT_LIMIT');
    // One past its deadline no longer counts either.
    getWorkflowDb().run("UPDATE workflow_human_request SET deadline = ? WHERE id = ?", [Date.now() - 1, second]);
    expect((await ask({ flowId: first.flowId, key: 'k23' })).requestId).toBeString();
  });
});

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { closeWorkflowDb, DEFAULT_IDS, getWorkflowDb, initWorkflowDb } from '../db';
import { createFlow } from '../db/repos/flow';
import { createDraftVersion } from '../db/repos/flow-version';
import { createFlowRun } from '../db/repos/flow-run';
import { createWaitpoint } from '../db/repos/waitpoint';
import { BriefCapabilities } from '../../brief/capabilities';
import { HUMAN_INPUT_PIECE } from './human-input-contract';
import { getHumanInput, humanInputQueue, listHumanInputs, requestHumanInput } from './human-input';
import { createWorkflowRoutes } from '../api/routes';

beforeEach(() => { initWorkflowDb(':memory:'); });
afterEach(() => { closeWorkflowDb(); });

function flowWithVersion(name = 'Payments', action = 'request_approval') {
  const flow = createFlow({});
  const version = createDraftVersion({ flowId: flow.id, displayName: name, trigger: { name: 'trigger', type: 'EMPTY',
    nextAction: { name: 'ask', type: 'PIECE', displayName: 'ask', settings: { pieceName: HUMAN_INPUT_PIECE, pieceVersion: '0.0.1', actionName: action,
      input: { title: 'Approve', prompt: 'Approve?', requestKey: 'k', timeoutHours: 1 } } } } as never });
  return { flow, version };
}
/** One run of the flow asking for approval, through the real request path. */
async function ask(flowId: string, versionId: string, input: Record<string, unknown> = {}) {
  const run = createFlowRun({ flowId, flowVersionId: versionId, status: 'RUNNING' });
  const reply = await requestHumanInput({ title: 'Approve', prompt: 'Approve?', requestKey: `k-${run.id}`, timeoutHours: 1, ...input },
    { runId: run.id, projectId: DEFAULT_IDS.project, stepName: 'ask', executionPath: [] }, Date.now()) as { requestId: string };
  return { requestId: reply.requestId, runId: run.id };
}

test('pending requests page oldest deadline first and the count never depends on the page', async () => {
  const { flow, version } = flowWithVersion();
  for (let i = 0; i < 12; i++) await ask(flow.id, version.id, { timeoutHours: 1 + i });
  const page = humanInputQueue(DEFAULT_IDS.project, { limit: 5 });
  expect(page.requests).toHaveLength(5); expect(page.pendingTotal).toBe(12);
  const all = humanInputQueue(DEFAULT_IDS.project);
  expect(all.requests).toHaveLength(12);
  expect(page.requests.map(r => r.id)).toEqual(all.requests.slice(0, 5).map(r => r.id));
  expect(page.requests.every(r => r.status === 'pending')).toBe(true);
  expect(listHumanInputs(DEFAULT_IDS.project)).toHaveLength(12);
});

test('each request carries its run outcome, including a shared request waited on by two runs', async () => {
  const { flow, version } = flowWithVersion('Daily update', 'request_input');
  const form = { fields: [{ key: 'a', label: 'A', type: 'text', required: true }], shareAcrossRuns: true, requestKey: 'shared-key' };
  const a = await ask(flow.id, version.id, form);
  const second = createFlowRun({ flowId: flow.id, flowVersionId: version.id, status: 'RUNNING' });
  await requestHumanInput({ title: 'Approve', prompt: 'Approve?', timeoutHours: 1, ...form },
    { runId: second.id, projectId: DEFAULT_IDS.project, stepName: 'ask', executionPath: [] }, Date.now());
  const lone = await ask(flow.id, version.id, { fields: form.fields });
  const byId = new Map(humanInputQueue(DEFAULT_IDS.project).requests.map(r => [r.id, r]));
  expect(byId.get(a.requestId)!.runs!.map(r => r.runId).sort()).toEqual([a.runId, second.id].sort());
  expect(byId.get(lone.requestId)!.runs).toEqual([{ runId: lone.runId, versionId: version.id, status: 'RUNNING' }]);
  expect(getHumanInput(DEFAULT_IDS.project, lone.requestId)!.runs).toEqual(byId.get(lone.requestId)!.runs);
  // A request whose run row is gone says so, as before.
  getWorkflowDb().run('PRAGMA foreign_keys=OFF'); getWorkflowDb().run('DELETE FROM flow_run WHERE id=?', [lone.runId]);
  expect(getHumanInput(DEFAULT_IDS.project, lone.requestId)!.runs).toEqual([{ runId: lone.runId, versionId: '', status: 'UNAVAILABLE' }]);
});

test('a request shows no bidi controls (G-12), while the stored request keeps what the workflow wrote', async () => {
  const { flow, version } = flowWithVersion();
  const evil = await ask(flow.id, version.id, { title: 'Pay \u202E0001 EUR\u202C now', prompt: 'Send \u2066100\u2069 to \u200Fbob\u200E', requestKey: 'k\u202Dx' });
  const shown = getHumanInput(DEFAULT_IDS.project, evil.requestId)!;
  expect(shown.title).toBe('Pay 0001 EUR now'); expect(shown.prompt).toBe('Send 100 to bob'); expect(shown.requestKey).toBe('kx');
  expect(humanInputQueue(DEFAULT_IDS.project).requests.find(r => r.id === evil.requestId)!.title).toBe('Pay 0001 EUR now');
  const stored = JSON.parse(getWorkflowDb().query<{ record: string }, [string]>('SELECT record FROM workflow_human_request WHERE id=?').get(evil.requestId)!.record);
  expect(stored.title).toBe('Pay \u202E0001 EUR\u202C now');
  // The whole set a card drops, not only bidi controls: a combining grapheme joiner, tag characters spelling hidden ASCII, a C0 control.
  const hidden = await ask(flow.id, version.id, { title: 'no\u034Ftes', prompt: 'Approve\u{E0041}\u{E0042} it\u0007', fields: [] });
  expect(getHumanInput(DEFAULT_IDS.project, hidden.requestId)).toMatchObject({ title: 'notes', prompt: 'Approve it' });
  // Ordinary text, line breaks and non-Latin scripts are untouched.
  const plain = await ask(flow.id, version.id, { title: 'Approve الدفع', prompt: 'Line one\nLine two' });
  expect(getHumanInput(DEFAULT_IDS.project, plain.requestId)).toMatchObject({ title: 'Approve الدفع', prompt: 'Line one\nLine two' });
});

test('with 1,000 pending requests a list is cheap: the run lookup is by id, not a scan of every paused run per request', () => {
  const { flow, version } = flowWithVersion(), db = getWorkflowDb(), now = Date.now();
  db.run('PRAGMA foreign_keys=OFF');
  db.transaction(() => {
    for (let i = 0; i < 1000; i++) {
      const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id, status: 'PAUSED' }), id = `req-${String(i).padStart(4, '0')}`;
      const wait = createWaitpoint({ flowRunId: run.id, projectId: DEFAULT_IDS.project, stepName: 'ask', type: 'MANUAL' });
      const record = { id, kind: 'approval', title: `Approve ${i}`, prompt: 'Approve?', fields: [], requestKey: `k${i}`, timeoutHours: 1, shared: false, workflowName: 'Payments',
        flowId: flow.id, runId: run.id, created: now - i, deadline: now + 3_600_000 + i, status: 'pending', answers: null };
      db.run('INSERT INTO workflow_human_request (id,project_id,flow_id,fingerprint,record,deadline,status) VALUES (?,?,?,?,?,?,?)',
        [id, DEFAULT_IDS.project, flow.id, id, JSON.stringify(record), record.deadline, 'pending']);
      db.run('INSERT INTO workflow_human_wait (request_id,run_id,waitpoint_id,generation) VALUES (?,?,?,0)', [id, run.id, wait.id]);
    }
  })();
  humanInputQueue(DEFAULT_IDS.project, { limit: 50 });
  const started = performance.now(), page = humanInputQueue(DEFAULT_IDS.project, { limit: 50 }), took = performance.now() - started;
  expect(page.pendingTotal).toBe(1000); expect(page.requests).toHaveLength(50);
  // About 5 ms with the run found by id; about 750 ms when every request scanned every paused run.
  expect(took).toBeLessThan(300);
});

test('GET /api/workflow-inputs takes a limit, defaults to a page, and reports every pending request', async () => {
  const { flow, version } = flowWithVersion();
  for (let i = 0; i < 7; i++) await ask(flow.id, version.id);
  const routes = createWorkflowRoutes({ briefCapabilities: new BriefCapabilities([{ id: 'decisions', provider: { readiness: () => 'ready' as const } }], ['decisions']) } as never);
  const get = (qs: string) => routes['/api/workflow-inputs']!.GET!(Object.assign(new Request(`http://localhost/api/workflow-inputs${qs}`), { params: {} }));
  const limited = await (await get('?limit=3')).json() as { requests: unknown[]; pendingTotal: number };
  expect(limited.requests).toHaveLength(3); expect(limited.pendingTotal).toBe(7);
  const full = await (await get('')).json() as { requests: unknown[]; pendingTotal: number };
  expect(full.requests).toHaveLength(7); expect(full.pendingTotal).toBe(7);
  for (const bad of ['?limit=0', '?limit=501', '?limit=x', '?limit=-1']) expect((await get(bad)).status).toBe(400);
});

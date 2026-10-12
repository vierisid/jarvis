import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initWorkflowDb, getWorkflowDb, closeWorkflowDb, DEFAULT_IDS } from '../workflows/db';
import { createFlow, setPublishedVersion } from '../workflows/db/repos/flow';
import { createDraftVersion, lockVersion } from '../workflows/db/repos/flow-version';
import { configureWorkflowReadiness } from '../workflows/db/repos/flow-readiness';
import { WorkflowContext } from '../brief/workflow-context';
import { registerWorkflowContext } from '../brief/registrations/workflow-context';
import { BriefCapabilities } from '../brief/capabilities';
import { createApiRoutes, type ApiContext } from './api-routes';
import { createWorkflowRoutes, WAITPOINT_RESUME_MAX_BODY_BYTES } from '../workflows/api/routes';
import { WebSocketServer } from '../comms/websocket';
import { PanelSessionStore } from '../sidecar/panel-sessions';
import type { SidecarManager } from '../sidecar/manager';

let service: WorkflowContext, flowId: string, versionId: string, saved: string | undefined;
beforeEach(() => {
  saved = process.env.JARVIS_BRIEF_WORKFLOW_CONTEXT; process.env.JARVIS_BRIEF_WORKFLOW_CONTEXT = '1';
  initWorkflowDb(':memory:'); configureWorkflowReadiness({ tool: () => null });
  service = new WorkflowContext(getWorkflowDb()); flowId = createFlow().id;
  versionId = lockVersion(createDraftVersion({ flowId, displayName: 'Fixture', trigger: { name: 'trigger', type: 'EMPTY', settings: {} } }).id).id;
  setPublishedVersion(flowId, versionId);
});
afterEach(() => { closeWorkflowDb(); if (saved === undefined) delete process.env.JARVIS_BRIEF_WORKFLOW_CONTEXT; else process.env.JARVIS_BRIEF_WORKFLOW_CONTEXT = saved; });
function table(enabled = true, registered = service) {
  const briefCapabilities = new BriefCapabilities(registerWorkflowContext(registered), enabled ? ['workflowContext'] : []);
  return { ...createApiRoutes({ briefWorkflowContext: service, briefCapabilities } as ApiContext),
    ...createWorkflowRoutes({ briefWorkflowContext: service, briefCapabilities }) } as Record<string, any>;
}
const base = '/api/brief/workflows/:flowId', selection = base + '/inspection', list = base + '/runs', detail = list + '/:runId', request = base + '/run-requests/:requestId', start = '/api/workflows/:id/run';
const command = (requestId = 'fixture-request') => ({ brief: { scopeId: DEFAULT_IDS.project, versionId, requestId }, payload: {} });
async function call(path: string, body?: unknown, query = '', routes = table(), params: Record<string, string> = {}) {
  const all = { id: flowId, flowId, requestId: 'fixture-request', ...params }, method = path === start ? 'POST' : 'GET';
  const req = Object.assign(new Request('http://localhost' + path + query, { method,
    ...(method === 'GET' ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) }), { params: all });
  const response = await routes[path][method](req);
  return { status: response.status, body: await response.json(), cache: response.headers.get('Cache-Control') };
}
test('new HTTP contract returns the existing queued run, list, selected context, detail and request recovery', async () => {
  const accepted = await call(start, command()); expect(accepted.status).toBe(202); expect(accepted.cache).toBe('no-store');
  expect(accepted.body).toMatchObject({ status: 'accepted', requestId: 'fixture-request', run: { flowId, versionId, status: 'queued' } });
  const runId = accepted.body.run.runId;
  expect((await call(request)).body).toEqual(accepted.body);
  expect((await call(list)).body.data.items[0].runId).toBe(runId);
  const selected = await call(selection, undefined, `?versionId=${versionId}&runId=${runId}`);
  expect(selected.cache).toBe('no-store'); expect(selected.body.data).toMatchObject({ flowId, versionId, runId, context: { basis: 'recorded', versionId, runId } });
  expect((await call(detail, undefined, '', table(), { runId })).body.data.versionId).toBe(versionId);
});
test('simultaneous UI retries accept one request, one job and one run', async () => {
  const routes = table(), responses = await Promise.all(Array.from({ length: 16 }, () => call(start, command(), '', routes)));
  expect(responses.every(r => r.status === 202 && r.body.run.runId === responses[0]!.body.run.runId)).toBe(true);
  expect(getWorkflowDb().query('SELECT id FROM flow_run').all()).toHaveLength(1);
  expect(getWorkflowDb().query('SELECT id FROM workflow_job').all()).toHaveLength(1);
});
test('missing or mismatched provider, disabled capability and disabled flag fail closed on reads and manual starts', async () => {
  const other = new WorkflowContext(getWorkflowDb());
  for (const routes of [table(false), table(true, other)]) {
    for (const [path, body, query] of [[start, command(), ''], [selection, undefined, `?versionId=${versionId}`]] as const)
      expect([501,503]).toContain((await call(path, body, query, routes)).status);
  }
  const missing = { ...createApiRoutes({} as ApiContext), ...createWorkflowRoutes() };
  expect((await call(start, command(), '', missing)).status).toBe(501);
  expect((await call(list, undefined, '', missing)).status).toBe(501);
  delete process.env.JARVIS_BRIEF_WORKFLOW_CONTEXT;
  expect((await call(start, command())).status).toBe(503); expect((await call(list)).status).toBe(503);
  expect(getWorkflowDb().query('SELECT id FROM flow_run').all()).toHaveLength(0);
});
test('invalid query, foreign identity, conflicting payload and explicit-input omissions fail without execution', async () => {
  for (const query of ['', `?versionId=${versionId}&versionId=${versionId}`, `?versionId=${versionId}&projectId=foreign`])
    expect((await call(selection, undefined, query)).status).toBe(400);
  const foreign = createFlow({ projectId: 'foreign' });
  expect((await call(start, command(), '', table(), { id: foreign.id })).status).toBe(404);
  expect((await call(list, undefined, '', table(), { flowId: foreign.id })).status).toBe(404);
  for (const value of [{ brief: command().brief }, { ...command(), workItemId: 'x' }, { ...command(), payload: null }, { ...command(), payload: [] }])
    expect((await call(start, value)).status).toBe(400);
  expect((await call(start, command())).status).toBe(202);
  expect((await call(start, { ...command(), payload: { changed: true } })).status).toBe(409);
  expect(getWorkflowDb().query('SELECT id FROM flow_run').all()).toHaveLength(1);
});
test('preserves #666 JSON/environment/label guards and both request size bounds', async () => {
  expect((await call(start, '{')).status).toBe(400);
  expect((await call(start, { environment: 'BOGUS' })).status).toBe(400);
  expect((await call(start, { triggeredBy: 'x'.repeat(201) })).status).toBe(400);
  expect((await call(start, { payload: 'x'.repeat(WAITPOINT_RESUME_MAX_BODY_BYTES) })).status).toBe(413);
  expect((await call(start, { ...command(), payload: { text: 'x'.repeat(65_537) } })).status).toBe(413);
  expect(getWorkflowDb().query('SELECT id FROM flow_run').all()).toHaveLength(0);
  // Existing non-Brief clients keep their optional-body behavior.
  expect((await call(start, '   ')).status).toBe(202);
});
test('streamed body beyond the common cap cannot start a run', async () => {
  const req = Object.assign(new Request('http://localhost/api/workflows/x/run', { method: 'POST', body: new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(WAITPOINT_RESUME_MAX_BODY_BYTES + 1)); controller.close(); },
  }) }), { params: { id: flowId } });
  const response = await table()[start].POST(req); expect(response.status).toBe(413);
  expect(getWorkflowDb().query('SELECT id FROM flow_run').all()).toHaveLength(0);
});
test('rechecks project ownership after the body await', async () => {
  const data = JSON.stringify(command());
  const req = Object.assign(new Request('http://localhost/api/workflows/x/run', { method: 'POST', body: new ReadableStream({
    pull(controller) { getWorkflowDb().run('UPDATE flow SET project_id=? WHERE id=?', ['foreign', flowId]); controller.enqueue(new TextEncoder().encode(data)); controller.close(); },
  }) }), { params: { id: flowId } });
  const response = await table()[start].POST(req); expect(response.status).toBe(404);
  expect(getWorkflowDb().query('SELECT id FROM flow_run').all()).toHaveLength(0);
});
test('real panel authentication protects every inspection and start route over an isolated Unix socket', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-f21-http-')), socket = join(directory, 'api.sock');
  const server = new WebSocketServer(0, socket), sessions = new PanelSessionStore();
  server.setSidecarManager({ openPanelSession: async (token: string) => token === 'fixture-access' ? sessions.create('fixture') : null,
    resolvePanelSession: (value: string) => sessions.get(value) } as SidecarManager);
  server.setApiRoutes(table());
  const send = (path: string, init: RequestInit = {}) => fetch('http://localhost' + path, { ...init, unix: socket });
  const listUrl = `/api/brief/workflows/${flowId}/runs`, startUrl = `/api/workflows/${flowId}/run`;
  try {
    server.start();
    for (const path of [listUrl, `/api/brief/workflows/${flowId}/inspection?versionId=${versionId}`, `${listUrl}/unknown`, `/api/brief/workflows/${flowId}/run-requests/fixture-request`])
      expect((await send(path)).status).toBe(401);
    expect((await send(startUrl, { method: 'POST', body: JSON.stringify(command()) })).status).toBe(401);
    const bootstrap = await send(listUrl + '?token=fixture-access', { redirect: 'manual' });
    const headers = { Cookie: bootstrap.headers.get('set-cookie')!.split(';')[0]! };
    const response = await send(startUrl, { method: 'POST', headers, body: JSON.stringify(command()) });
    expect(response.status).toBe(202); const result = await response.json() as any;
    for (const path of [listUrl, `/api/brief/workflows/${flowId}/inspection?versionId=${versionId}&runId=${result.run.runId}`, `${listUrl}/${result.run.runId}`, `/api/brief/workflows/${flowId}/run-requests/fixture-request`]) {
      const reply = await send(path, { headers }); expect(reply.status).toBe(200); expect(reply.headers.get('Cache-Control')).toBe('no-store');
    }
  } finally { server.stop(); rmSync(directory, { recursive: true, force: true }); }
});

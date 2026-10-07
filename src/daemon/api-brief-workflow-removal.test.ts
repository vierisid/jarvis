import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initWorkflowDb, getWorkflowDb, closeWorkflowDb } from '../workflows/db';
import { createFlow, getFlow, listFlows } from '../workflows/db/repos/flow';
import { createDraftVersion } from '../workflows/db/repos/flow-version';
import { WorkflowRemoval } from '../brief/workflow-removal';
import { registerWorkflowRemoval } from '../brief/registrations/workflow-removal';
import { BriefCapabilities } from '../brief/capabilities';
import { createApiRoutes, type ApiContext } from './api-routes';
import { WebSocketServer } from '../comms/websocket';
import { PanelSessionStore } from '../sidecar/panel-sessions';
import type { SidecarManager } from '../sidecar/manager';

let service: WorkflowRemoval, flowId: string, saved: string | undefined;
beforeEach(() => {
  saved = process.env.JARVIS_BRIEF_WORKFLOW_REMOVAL; process.env.JARVIS_BRIEF_WORKFLOW_REMOVAL = '1'; initWorkflowDb(':memory:');
  service = new WorkflowRemoval(getWorkflowDb()); service.start({ refresh: async () => {} });
  flowId = createFlow({ metadata: { privateFixture: 'not a projection field' } }).id;
  createDraftVersion({ flowId, displayName: 'Fixture workflow', trigger: { name: 'trigger', type: 'EMPTY', settings: {} } });
});
afterEach(() => { service.stop(); closeWorkflowDb(); if (saved === undefined) delete process.env.JARVIS_BRIEF_WORKFLOW_REMOVAL; else process.env.JARVIS_BRIEF_WORKFLOW_REMOVAL = saved; });
function table(enabled = true, registered = service) {
  return createApiRoutes({ briefWorkflowRemoval: service,
    briefCapabilities: new BriefCapabilities(registerWorkflowRemoval(registered), enabled ? ['workflowRemoval'] : []) } as ApiContext) as Record<string, any>;
}
const listPath = '/api/brief/workflows', commandPath = listPath + '/commands', requestPath = listPath + '/requests/:requestId';
async function call(path = listPath, body?: unknown, suffix = '', routes = table(), requestId = 'fixture-request') {
  const method = body === undefined ? 'GET' : 'POST';
  const req = Object.assign(new Request('http://localhost' + path.replace(':requestId', requestId) + suffix, { method,
    ...(body === undefined ? {} : { body: body instanceof Uint8Array ? Buffer.from(body) : typeof body === 'string' ? body : JSON.stringify(body) }) }), { params: { requestId } });
  const response = await routes[path][method](req); expect(response.headers.get('Cache-Control')).toBe('no-store');
  return { status: response.status, body: await response.json() };
}
const command = () => {
  const item = service.read().data.items[0]!;
  return { scopeId: service.projectId, flowId, versionId: item.versionId, expectedRevision: item.revision, requestId: 'fixture-request', action: 'remove' };
};
test('authenticated contract prepares a complete list, removes, recovers request and restores paused', async () => {
  const list = await call(); expect(list.status).toBe(200); expect(list.body.data.items).toHaveLength(1);
  expect(JSON.stringify(list.body)).not.toContain('not a projection field');
  const c = command(), result = await call(commandPath, c); expect(result.status).toBe(200);
  expect(result.body).toMatchObject({ status: 'accepted', action: 'remove', flowId }); expect(listFlows()).toEqual([]);
  expect(await call(commandPath, c)).toEqual(result); expect(await call(requestPath)).toEqual(result);
  const recovered = await call(); expect(recovered.body.data.removals[0]).toMatchObject({ flowId, expectedRevision: c.expectedRevision, undoAvailable: true });
  expect((await call(commandPath, { ...c, requestId: 'restore', action: 'restore', receiptId: result.body.receipt.receiptId })).body)
    .toMatchObject({ status: 'accepted', item: { flowId, activation: 'DISABLED', versionId: c.versionId } });
  expect(getFlow(flowId)?.status).toBe('DISABLED');
});
test('malformed, oversized, cross-scope, stale and conflicting commands do not mutate', async () => {
  const c = command();
  for (const value of [null, [], {}, { ...c, extra: true }, { ...c, activation: 'ENABLED' }, { ...c, action: 'purge' }, { ...c, versionId: undefined }, '{', new Uint8Array([0xff])]) {
    expect((await call(commandPath, value)).status).toBe(400);
  }
  expect((await call(commandPath, 'x'.repeat(4097))).status).toBe(413);
  expect((await call(commandPath, c, '?force=true')).status).toBe(400);
  expect((await call(commandPath, { ...c, scopeId: 'foreign' })).status).toBe(404);
  expect((await call(requestPath, undefined, '', table(), '%')).status).toBe(400);
  expect((await call(requestPath, undefined, '', table(), 'unknown')).status).toBe(404);
  expect((await call(commandPath, { ...c, expectedRevision: '0'.repeat(64) })).body).toMatchObject({ status: 'rejected', code: 'revision_conflict' });
  expect((await call(commandPath, c)).status).toBe(409); expect(listFlows()).toHaveLength(1);
});
test('missing, mismatched, unconfigured, disabled and foreign-vault providers fail closed', async () => {
  expect((await call(listPath, undefined, '', createApiRoutes({} as ApiContext))).status).toBe(501);
  const other = new WorkflowRemoval(getWorkflowDb());
  expect((await call(listPath, undefined, '', table(true, other))).status).toBe(501);
  expect((await call(listPath, undefined, '', table(false))).status).toBe(503);
  service.stop(); expect((await call()).status).toBe(503); service.start({ refresh: async () => {} });
  delete process.env.JARVIS_BRIEF_WORKFLOW_REMOVAL; expect((await call()).status).toBe(503); process.env.JARVIS_BRIEF_WORKFLOW_REMOVAL = '1';
  const routes = table(); closeWorkflowDb(); initWorkflowDb(':memory:'); expect((await call(listPath, undefined, '', routes)).status).toBe(503);
});
test('all three routes enforce real panel authentication over a Unix socket', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-f20-http-')), socket = join(directory, 'api.sock');
  const server = new WebSocketServer(0, socket), sessions = new PanelSessionStore();
  server.setSidecarManager({ openPanelSession: async (token: string) => token === 'fixture-access' ? sessions.create('fixture') : null,
    resolvePanelSession: (value: string) => sessions.get(value) } as SidecarManager);
  server.setApiRoutes(table());
  const send = (path: string, init: RequestInit = {}) => fetch('http://localhost' + path, { ...init, unix: socket });
  try {
    server.start(); const c = command();
    expect((await send(listPath)).status).toBe(401); expect((await send(commandPath, { method: 'POST', body: JSON.stringify(c) })).status).toBe(401);
    expect((await send(requestPath.replace(':requestId', c.requestId))).status).toBe(401);
    const bootstrap = await send(listPath + '?token=fixture-access', { redirect: 'manual' });
    const headers = { Cookie: bootstrap.headers.get('set-cookie')!.split(';')[0]! };
    const response = await send(commandPath, { method: 'POST', headers, body: JSON.stringify(c) });
    expect(response.status).toBe(200); expect((await response.json() as any).status).toBe('accepted');
    const recovered = await send(requestPath.replace(':requestId', c.requestId), { headers });
    expect(recovered.headers.get('Cache-Control')).toBe('no-store'); expect((await recovered.json() as any).receipt.flowId).toBe(flowId);
    expect((await send(listPath, { headers })).status).toBe(200);
  } finally { server.stop(); rmSync(directory, { recursive: true, force: true }); }
});

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { closeDb, getDb } from '../vault/schema';
import { initWorkflowDb } from '../workflows/db';
import { ApprovalManager } from '../authority/approval';
import { DeferredExecutor } from '../authority/deferred-executor';
import { AuditTrail } from '../authority/audit';
import type { ToolRegistry } from '../actions/tools/registry';
import { createWorkItem } from '../goals/work-items';
import { DecisionQueue } from '../brief/decisions';
import { BriefCapabilities } from '../brief/capabilities';
import { registerDecisions } from '../brief/registrations/decisions';
import { createApiRoutes, type ApiContext } from './api-routes';
import { WebSocketServer } from '../comms/websocket';
import { PanelSessionStore } from '../sidecar/panel-sessions';
import type { SidecarManager } from '../sidecar/manager';

type Handler = (req: Request & { params: { id: string } }) => Response | Promise<Response>;
type Routes = Record<string, Partial<Record<'GET' | 'POST', Handler>>>;
let queue: DecisionQueue, manager: ApprovalManager, executor: DeferredExecutor, calls: number;
beforeEach(() => {
  initWorkflowDb(':memory:'); manager = new ApprovalManager(); executor = new DeferredExecutor(manager, new AuditTrail()); calls = 0;
  executor.setToolRegistry({ get: () => undefined, execute: async () => { calls++; return 'Fixture completed'; } } as unknown as ToolRegistry);
  queue = new DecisionQueue(getDb(), { approvalManager: manager, deferredExecutor: executor });
});
afterEach(() => closeDb());
const base = '/api/brief/decisions';
function routes(enabled = true, provider: DecisionQueue | undefined = queue, registered: DecisionQueue | undefined = provider) {
  return createApiRoutes({ briefDecisions: provider,
    briefCapabilities: new BriefCapabilities(registerDecisions(registered), enabled ? ['decisions'] : []),
  } as ApiContext) as Routes;
}
async function call(table: Routes, suffix = '', method: 'GET' | 'POST' = 'GET', id = '', data?: unknown, query = '') {
  const request = Object.assign(new Request(`http://localhost${base}${suffix.replace(':id', encodeURIComponent(id))}${query}`, {
    method, ...(data === undefined ? {} : { body: JSON.stringify(data), headers: { 'Content-Type': 'application/json' } }),
  }), { params: { id } });
  const response = await table[`${base}${suffix}`]![method]!(request);
  expect(response.headers.get('cache-control')).toBe('no-store');
  return { status: response.status, body: await response.json() as any };
}

test('missing, disabled and mismatched providers fail closed for reads, placement and resolution', async () => {
  const work = createWorkItem({ title: 'Fixture' }); const item = queue.get(`work:${work.id}`);
  const other = new DecisionQueue(getDb(), { approvalManager: manager, deferredExecutor: executor });
  for (const [table, status] of [[routes(false), 503], [routes(true, queue, other), 501]] as const) {
    expect((await call(table)).status).toBe(status);
    expect((await call(table, '/:id/resolve', 'POST', item.decisionId, { revision: item.revision, action: 'accept_intent', reason: 'Fixture' })).status).toBe(status);
    expect((await call(table, '/:id/placement', 'POST', item.decisionId, { revision: item.revision, position: -1 })).status).toBe(status);
  }
  const missing = createApiRoutes({} as ApiContext) as Routes;
  expect((await call(missing)).status).toBe(501);
  expect(queue.get(item.decisionId).state).toBe('proposed'); expect(calls).toBe(0);
});

test('same canonical state after action and reload, stale action conflicts, no hidden execution', async () => {
  const table = routes(); const work = createWorkItem({ title: 'Fixture' });
  const list = await call(table); const item = list.body.data.items[0];
  expect(item.decisionId).toBe(`work:${work.id}`);
  const accepted = await call(table, '/:id/resolve', 'POST', item.decisionId, { revision: item.revision, action: 'accept_intent', reason: 'Proceed' });
  expect(accepted.status).toBe(200); expect(accepted.body.state).toBe('ready');
  expect((await call(table, '/:id', 'GET', item.decisionId)).body).toEqual(accepted.body);
  expect((await call(table, '/:id/resolve', 'POST', item.decisionId, { revision: item.revision, action: 'accept_intent', reason: 'Proceed' })).status).toBe(409);
  expect(calls).toBe(0);
});

test('invalid query, placement, actions and oversized bodies cannot write', async () => {
  const table = routes(), work = createWorkItem({ title: 'Fixture' }), item = queue.get(`work:${work.id}`);
  for (const query of ['?limit=101','?today=1','?limit=2&limit=3','?cursor=%%%','?runId=']) expect((await call(table, '', 'GET', '', undefined, query)).status).toBe(400);
  for (const data of [{ revision: item.revision, position: 1.1 }, { revision: item.revision, position: 0, hidden: true }, { revision: 'stale', position: 0 }]) {
    expect([400,409]).toContain((await call(table, '/:id/placement', 'POST', item.decisionId, data)).status);
  }
  for (const data of [[], {}, { revision: item.revision, action: 'approve_permission' },
    { revision: item.revision, action: 'accept_intent' }, { revision: item.revision, action: 'accept_intent', reason: 'Proceed', execute: true }]) {
    expect([400,409]).toContain((await call(table, '/:id/resolve', 'POST', item.decisionId, data)).status);
  }
  expect((await call(table, '/:id/resolve', 'POST', item.decisionId, { revision: item.revision, action: 'accept_intent', reason: 'x'.repeat(49_000) })).status).toBe(413);
  expect((await call(table, '/:id', 'GET', 'work:missing')).status).toBe(404);
  expect(queue.get(item.decisionId)).toEqual(item);
});

test('authenticated HTTP round trip rejects unauthenticated writes and preserves decision identity', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-f12-http-')), socket = join(dir, 'api.sock');
  const server = new WebSocketServer(0, socket), sessions = new PanelSessionStore();
  const sidecar: Pick<SidecarManager, 'openPanelSession' | 'resolvePanelSession'> = {
    openPanelSession: async token => token === 'fixture-access' ? sessions.create('fixture-sidecar') : null,
    resolvePanelSession: id => sessions.get(id),
  };
  server.setSidecarManager(sidecar as SidecarManager);
  server.setApiRoutes(routes() as any);
  const work = createWorkItem({ title: 'Fixture HTTP' }), item = queue.get(`work:${work.id}`);
  const get = (path: string, init: RequestInit = {}) => fetch(`http://localhost${path}`, { ...init, unix: socket });
  try {
    server.start();
    expect((await get(base)).status).toBe(401);
    const path = `${base}/${encodeURIComponent(item.decisionId)}`;
    expect((await get(`${path}/resolve`, { method: 'POST', body: JSON.stringify({ revision: item.revision, action: 'accept_intent', reason: 'Proceed' }) })).status).toBe(401);
    expect(queue.get(item.decisionId).state).toBe('proposed');
    const bootstrap = await get(`${base}?token=fixture-access`, { redirect: 'manual' });
    const cookie = bootstrap.headers.get('set-cookie')!.split(';')[0]!;
    const headers = { Cookie: cookie, 'Content-Type': 'application/json' };
    const listed = await get(base, { headers }); expect(listed.status).toBe(200);
    expect(listed.headers.get('cache-control')).toBe('no-store');
    const first = await get(`${path}/resolve`, { method: 'POST', headers, body: JSON.stringify({ revision: item.revision, action: 'accept_intent', reason: 'Proceed' }) });
    expect(first.status).toBe(200); const accepted = await first.json();
    expect(await (await get(path, { headers })).json()).toEqual(accepted);
    expect((await get(`${path}/resolve`, { method: 'POST', headers, body: JSON.stringify({ revision: item.revision, action: 'accept_intent', reason: 'Proceed' }) })).status).toBe(409);
    expect(calls).toBe(0);
  } finally { server.stop(); rmSync(dir, { recursive: true, force: true }); }
});

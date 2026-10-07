import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { closeDb, getDb } from '../vault/schema';
import { initWorkflowDb } from '../workflows/db';
import { ApprovalManager } from '../authority/approval';
import { DeferredExecutor } from '../authority/deferred-executor';
import { AuditTrail } from '../authority/audit';
import { DecisionQueue } from '../brief/decisions';
import { Recommendations } from '../brief/recommendations';
import { BriefCapabilities } from '../brief/capabilities';
import { registerDecisions } from '../brief/registrations/decisions';
import { registerRecommendations } from '../brief/registrations/recommendations';
import { createApiRoutes, type ApiContext } from './api-routes';
import { WebSocketServer } from '../comms/websocket';
import { PanelSessionStore } from '../sidecar/panel-sessions';
import type { SidecarManager } from '../sidecar/manager';

type Handler = (req: Request & { params: { id: string } }) => Response | Promise<Response>;
type Routes = Record<string, Partial<Record<'GET' | 'POST', Handler>>>;
let queue: DecisionQueue, provider: Recommendations;
beforeEach(() => {
  initWorkflowDb(':memory:'); const manager = new ApprovalManager();
  queue = new DecisionQueue(getDb(), { approvalManager: manager, deferredExecutor: new DeferredExecutor(manager, new AuditTrail()) });
  provider = new Recommendations(getDb(), queue, { readiness: () => 'ready', plan: now => ({
    planner: 'next-action-v1', basis: 'a'.repeat(64), generatedAt: now, expiresAt: now + 100_000, outcome: 'recommend',
    action: { kind: 'review_goal', title: 'Review existing evidence', goal: null, workItemId: null,
      rationale: ['Evidence needs review'], evidence: [{ kind: 'source', id: 'fixture', revision: null }], load: 'none' },
  }) });
});
afterEach(() => closeDb());
const base = '/api/brief/recommendations';
function routes(enabled = true, decisions = true, registered = provider) {
  return createApiRoutes({ briefRecommendations: provider, briefDecisions: queue,
    briefCapabilities: new BriefCapabilities([...registerDecisions(queue), ...registerRecommendations(registered)],
      [...(enabled ? ['recommendations' as const] : []), ...(decisions ? ['decisions' as const] : [])]),
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
test('missing registration, feature flag and decision dependency all fail closed', async () => {
  const other = new Recommendations(getDb(), queue, null);
  for (const [table, status] of [[routes(false), 503], [routes(true, false), 503], [routes(true, true, other), 501],
    [createApiRoutes({} as ApiContext) as Routes, 501]] as const) {
    expect((await call(table)).status).toBe(status);
    expect((await call(table, '', 'POST', '', { requestId: 'missing' })).status).toBe(status);
    expect((await call(table, '/:id/accept', 'POST', 'missing', { requestId: 'missing', revision: 'missing' })).status).toBe(status);
  }
});
test('return, refresh, dismissal and malformed input preserve the server-owned plan', async () => {
  const table = routes(); expect((await call(table)).body).toBeNull();
  const generated = await call(table, '', 'POST', '', { requestId: 'generation' }); expect(generated.status).toBe(200);
  const rec = generated.body;
  expect((await call(table, '', 'GET', '', undefined, '?requestId=generation')).body).toEqual(rec);
  const dismissed = await call(table, '/:id/dismiss', 'POST', rec.recommendationId, { revision: rec.revision });
  expect(dismissed.body.state).toBe('dismissed');
  expect((await call(table, '/:id/accept', 'POST', rec.recommendationId, { requestId: 'accept', revision: dismissed.body.revision })).status).toBe(409);
  for (const input of [{}, [], { requestId: 'x', plan: rec.plan }, { requestId: 'x'.repeat(9000) }]) {
    expect([400,413]).toContain((await call(table, '', 'POST', '', input)).status);
  }
  for (const query of ['?goalId=x', '?requestId=x&requestId=y']) expect((await call(table, '', 'GET', '', undefined, query)).status).toBe(400);
  expect((await call(table, '/:id', 'GET', 'missing')).status).toBe(404);
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
  const seed = provider.generate('http-generation');
  const item = seed;
  const get = (path: string, init: RequestInit = {}) => fetch(`http://localhost${path}`, { ...init, unix: socket });
  try {
    server.start();
    expect((await get(base)).status).toBe(401);
    const path = `${base}/${encodeURIComponent(item.recommendationId)}`;
    expect((await get(`${path}/accept`, { method: 'POST', body: JSON.stringify({ revision: item.revision, requestId: 'http-accept' }) })).status).toBe(401);
    expect(provider.get(item.recommendationId).state).toBe('available');
    const bootstrap = await get(`${base}?token=fixture-access`, { redirect: 'manual' });
    const cookie = bootstrap.headers.get('set-cookie')!.split(';')[0]!;
    const headers = { Cookie: cookie, 'Content-Type': 'application/json' };
    const listed = await get(base, { headers }); expect(listed.status).toBe(200);
    expect(listed.headers.get('cache-control')).toBe('no-store');
    const first = await get(`${path}/accept`, { method: 'POST', headers, body: JSON.stringify({ revision: item.revision, requestId: 'http-accept' }) });
    expect(first.status).toBe(200); const accepted = await first.json();
    expect((await (await get(path, { headers })).json() as any).acceptance).toEqual(accepted);
    expect(await (await get(`${path}/accept`, { method: 'POST', headers, body: JSON.stringify({ revision: item.revision, requestId: 'http-accept' }) })).json()).toEqual(accepted);
    expect((getDb().query('SELECT count(*) AS n FROM commitment_work').get() as any).n).toBe(1);
  } finally { server.stop(); rmSync(dir, { recursive: true, force: true }); }
});

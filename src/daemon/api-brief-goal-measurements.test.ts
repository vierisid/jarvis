import { ensureWorkflowSchema } from '../workflows/db';
import { createWorkItem, decideWorkItem, getWorkItem } from '../goals/work-items';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { closeDb, getDb, initDatabase } from '../vault/schema';
import { getGoal, getProgressHistory } from '../vault/goals';
import { getGoalApplication } from '../goals/application-service';
import { GoalMeasurements } from '../brief/goal-measurements';
import { BriefCapabilities } from '../brief/capabilities';
import { registerGoalMeasurements } from '../brief/registrations/goal-measurements';
import { createApiRoutes, type ApiContext } from './api-routes';
import { WebSocketServer } from '../comms/websocket';
import { PanelSessionStore } from '../sidecar/panel-sessions';
import type { SidecarManager } from '../sidecar/manager';

type Handler = (req: Request & { params: { id: string } }) => Response | Promise<Response>;
type Routes = Record<string, Partial<Record<'GET' | 'POST', Handler>>>;
const base = '/api/brief/goals/:id', write = `${base}/measurement`;
let id: string, provider: GoalMeasurements;
beforeEach(() => {
  initDatabase(':memory:', { quiet: true });
  id = getGoalApplication().createGoal('Goal with 10 in its title', 'objective').id;
  provider = new GoalMeasurements(getDb());
});
afterEach(() => { getGoalApplication().stopDelivery(); closeDb(); });
function routes(enabled = true, registered: GoalMeasurements | undefined = provider): Routes {
  return createApiRoutes({ briefGoalMeasurements: provider,
    briefCapabilities: new BriefCapabilities(registerGoalMeasurements(registered), enabled ? ['goalMeasurements'] : []),
  } as ApiContext) as Routes;
}
function command() { return { requestId: 'http1', revision: 0, measurement: { unit: 'signed partners', baseline: 0, target: 10,
  value: 6, measuredAt: Date.now() - 1000, evidence: { id: 'owner:ledger', revision: 'v1' } } }; }
async function call(table: Routes, path = base, method: 'GET' | 'POST' = 'GET', body?: unknown, query = '', goalId = id) {
  const req = Object.assign(new Request(`http://localhost${path.replace(':id', encodeURIComponent(goalId))}${query}`, {
    method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
  }), { params: { id: encodeURIComponent(goalId) } });
  const res = await table[path]![method]!(req);
  if (path.startsWith('/api/brief')) expect(res.headers.get('cache-control')).toBe('no-store');
  return { status: res.status, body: await res.json() as any };
}
test('missing, wrong, disabled and unavailable providers gate every measurement route', async () => {
  const missing = createApiRoutes({} as ApiContext) as Routes;
  for (const [table, expected] of [[missing, 501], [routes(false), 503], [routes(true, new GoalMeasurements(getDb())), 501]] as const) {
    expect((await call(table)).status).toBe(expected);
    expect((await call(table, write, 'GET', undefined, '?requestId=a')).status).toBe(expected);
    expect((await call(table, write, 'POST', command())).status).toBe(expected);
  }
  const table = routes(); closeDb(); initDatabase(':memory:', { quiet: true });
  expect((await call(table)).status).toBe(503); expect((await call(table, write, 'POST', command())).status).toBe(503);
});
test('read, write, receipt recovery and legacy goal routes agree on recorded measurement and progress', async () => {
  const table = routes(), before = await call(table); expect(before.body).toMatchObject({ state: 'ready', data: { measurement: null } });
  const input = command(), saved = await call(table, write, 'POST', input); expect(saved.status).toBe(200);
  expect(saved.body).toMatchObject({ score: 0.6, measurement: { revision: 1, value: 6, qualification: 'user_reported' } });
  expect((await call(table, write, 'POST', input)).body).toEqual(saved.body);
  expect((await call(table, write, 'GET', undefined, '?requestId=http1')).body.receipt).toEqual(saved.body);
  expect((await call(table)).body.data).toMatchObject({ score: 0.6, measurement: { value: 6, target: 10 }, progress: { value: 0.6, basis: 'measurement' } });
  expect((await call(table, '/api/goals/:id')).body.measurement).toEqual(saved.body.measurement);
  expect((await call(table, '/api/goals/roots')).body[0].measurement).toEqual(saved.body.measurement);
  expect((await call(table, '/api/goals/:id/tree')).body[0].measurement).toEqual(saved.body.measurement);
  expect((await call(table, '/api/goals/:id/score', 'POST', { score: 0.9 })).status).toBe(400);
  expect((await call(table, write, 'POST', { ...input, requestId: 'stale' })).status).toBe(409);
  expect(getProgressHistory(id)).toHaveLength(1);
  expect((await call(table, base, 'GET', undefined, '', 'missing')).body.state).toBe('empty');
});
test('bad shapes, forged qualification, malformed bytes, oversized bodies and query injection cannot write', async () => {
  const table = routes(), input = command();
  for (const value of [[], {}, { ...input, qualification: 'measured' }, { ...input, measurement: { ...input.measurement, qualification: 'measured' } },
    { ...input, measurement: { ...input.measurement, unit: 'x'.repeat(9000) } }]) expect((await call(table, write, 'POST', value)).status).toBe(400);
  for (const query of ['?requestId=a&requestId=b', '?raw=true', '?requestId=']) expect((await call(table, write, 'GET', undefined, query)).status).toBe(400);
  expect((await call(table, write, 'POST', input, '?raw=true')).status).toBe(400);
  for (const body of ['{', new Uint8Array([0xff])]) {
    const request = Object.assign(new Request('http://localhost', { method: 'POST', body }), { params: { id } });
    expect((await table[write]!.POST!(request)).status).toBe(400);
  }
  const badId = Object.assign(new Request('http://localhost'), { params: { id: '%' } });
  expect((await table[base]!.GET!(badId)).status).toBe(400);
  expect(getGoal(id)!.measurement).toBeNull(); expect(getProgressHistory(id)).toHaveLength(0);
});
test('authenticated HTTP requires a session for reads and writes, then recovers the same measurement receipt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-f15-http-')), socket = join(dir, 'api.sock');
  const server = new WebSocketServer(0, socket), sessions = new PanelSessionStore();
  server.setSidecarManager({ openPanelSession: async (token: string) => token === 'fixture-access' ? sessions.create('fixture-sidecar') : null,
    resolvePanelSession: (value: string) => sessions.get(value) } as SidecarManager);
  server.setApiRoutes(routes() as any);
  const path = base.replace(':id', id), input = command();
  const get = (url: string, init: RequestInit = {}) => fetch(`http://localhost${url}`, { ...init, unix: socket });
  try {
    server.start(); expect((await get(path)).status).toBe(401);
    expect((await get(`${path}/measurement`, { method: 'POST', body: JSON.stringify(input) })).status).toBe(401);
    expect(getGoal(id)!.measurement).toBeNull();
    const bootstrap = await get(`${path}?token=fixture-access`, { redirect: 'manual' });
    const headers = { Cookie: bootstrap.headers.get('set-cookie')!.split(';')[0]!, 'Content-Type': 'application/json' };
    const saved = await get(`${path}/measurement`, { method: 'POST', headers, body: JSON.stringify(input) }); expect(saved.status).toBe(200);
    const receipt = await saved.json();
    const recovered = await get(`${path}/measurement?requestId=http1`, { headers }); expect((await recovered.json() as any).receipt).toEqual(receipt);
    expect((await (await get(path, { headers })).json() as any).data.measurement).toMatchObject({ value: 6, qualification: 'user_reported' });
    expect(getProgressHistory(id)).toHaveLength(1);
  } finally { server.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test('work result checks refuse a conflicting score clearly and can complete without changing measured progress', async () => {
  ensureWorkflowSchema(); const table = routes();
  expect((await call(table, write, 'POST', command())).status).toBe(200);
  const work = createWorkItem({ title: 'Review signed contracts', goalId: id });
  decideWorkItem(work.id, { outcome: 'accepted', reason: 'Owner confirmed' });
  const result = { verdict: 'passed', summary: 'Contracts reviewed', evidence: [{ ref: 'contracts:v1', description: 'Owner review' }] };
  const rejected = await call(table, '/api/work-items/:id/result', 'POST', { ...result, goalScore: 1 }, '', work.id);
  expect(rejected.status).toBe(409); expect(rejected.body.error).toContain('measurement');
  expect(getWorkItem(work.id).resultCheck).toBeNull(); expect(getGoal(id)!.score).toBe(0.6);
  const accepted = await call(table, '/api/work-items/:id/result', 'POST', result, '', work.id);
  expect(accepted.status).toBe(200); expect(accepted.body.resultCheck.goalProgressId).toBeNull();
  expect(getGoal(id)!.score).toBe(0.6); expect(getProgressHistory(id)).toHaveLength(1);
});

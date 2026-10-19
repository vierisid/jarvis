import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initDatabase, closeDb, getDb } from '../vault/schema';
import { ensureWorkflowSchema } from '../workflows/db';
import { createFlow, setPublishedVersion } from '../workflows/db/repos/flow';
import { createDraftVersion, lockVersion } from '../workflows/db/repos/flow-version';
import { updateRun } from '../workflows/db/repos/flow-run';
import { createWorkItem, decideWorkItem, checkWorkResult } from '../goals/work-items';
import { startWorkItemRun } from '../goals/workflow-bridge';
import { getGoalApplication } from '../goals/application-service';
import { Outcomes } from '../brief/outcomes';
import { GoalMeasurements } from '../brief/goal-measurements';
import { BriefCapabilities } from '../brief/capabilities';
import { registerOutcomes } from '../brief/registrations/outcomes';
import { registerGoalMeasurements } from '../brief/registrations/goal-measurements';
import { createApiRoutes, type ApiContext } from './api-routes';
import { WebSocketServer } from '../comms/websocket';
import { PanelSessionStore } from '../sidecar/panel-sessions';
import type { SidecarManager } from '../sidecar/manager';

let provider: Outcomes, goals: GoalMeasurements;
beforeEach(() => { initDatabase(':memory:', { quiet: true }); ensureWorkflowSchema(); provider = new Outcomes(getDb()); goals = new GoalMeasurements(getDb()); });
afterEach(() => { getGoalApplication().stopDelivery(); closeDb(); });
function routes(enabled: ('outcomes' | 'goalMeasurements')[] = ['outcomes', 'goalMeasurements'], registered: Outcomes | undefined = provider) {
  return createApiRoutes({ briefOutcomes: provider,
    briefCapabilities: new BriefCapabilities([...registerOutcomes(registered), ...registerGoalMeasurements(goals)], enabled) } as ApiContext) as Record<string, any>;
}
const base = '/api/brief/outcomes', timePath = `${base}/:id/time`;
const query = () => `?start=${Date.now() - 86400000}&end=${Date.now() + 1}&timezone=UTC`;
async function call(table: ReturnType<typeof routes>, path = base, method = 'GET', suffix = query(), body?: unknown, id = 'work') {
  const req = Object.assign(new Request(`http://localhost${path.replace(':id', id)}${suffix}`, { method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), { params: { id } });
  const response = await table[path][method](req); expect(response.headers.get('Cache-Control')).toBe('no-store');
  return { status: response.status, body: await response.json() };
}
function checkedWork() {
  const flow = createFlow(), version = lockVersion(createDraftVersion({ flowId: flow.id, displayName: 'Checked report', trigger: { name: 'trigger', type: 'EMPTY' } }).id);
  setPublishedVersion(flow.id, version.id);
  const work = createWorkItem({ title: 'Report', mode: 'workflow', workflowId: flow.id, workflowVersionId: version.id });
  decideWorkItem(work.id, { outcome: 'accepted', reason: 'Requested' });
  const run = startWorkItemRun(work.id, flow.id); updateRun(run.id, { status: 'SUCCEEDED', finishTime: Date.now() });
  const done = checkWorkResult(work.id, { verdict: 'passed', summary: 'Matches source', evidence: [{ ref: 'source:1', description: 'Checked' }] });
  const command = { requestId: 'http-time', revision: 0, resultCheckId: done.resultCheck!.id,
    baseline: { minutes: 10, evidence: { id: 'manual-stopwatch', revision: '1' } },
    intervention: { intervals: [], evidence: { id: 'no-human-intervention-record', revision: '1' } } };
  return { work, command };
}
test('every route requires the exact ready provider plus both outcome and measurement activation', async () => {
  for (const [table, status] of [[createApiRoutes({} as ApiContext), 501], [routes([]), 503], [routes(['outcomes']), 503], [routes(['goalMeasurements']), 503], [routes(undefined, new Outcomes(getDb())), 501]] as const) {
    expect((await call(table)).status).toBe(status);
    expect((await call(table, `${base}/summary`, 'GET', '?timezone=UTC')).status).toBe(status);
    expect((await call(table, timePath, 'GET', '?requestId=x')).status).toBe(status);
    expect((await call(table, timePath, 'GET', '')).status).toBe(status);
    expect((await call(table, timePath, 'POST', '', {})).status).toBe(status);
  }
  const table = routes(); closeDb(); initDatabase(':memory:', { quiet: true });
  expect((await call(table)).status).toBe(503);
});
test('empty, qualified time, immutable receipt recovery and conflict responses', async () => {
  const table = routes(); expect((await call(table)).body.state).toBe('empty');
  const { work, command } = checkedWork();
  const saved = await call(table, timePath, 'POST', '', command, work.id); expect(saved.status).toBe(200);
  expect((await call(table, timePath, 'POST', '', command, work.id)).body).toEqual(saved.body);
  expect((await call(table, timePath, 'GET', '?requestId=http-time', undefined, work.id)).body.receipt).toEqual(saved.body);
  expect((await call(table)).body.data[0].timeBack).toMatchObject({ value: 10, qualification: 'user_reported' });
  expect((await call(table, `${base}/summary`, 'GET', '?timezone=UTC')).body.data.week.value).toBe(10);
  expect((await call(table, timePath, 'POST', '', { ...command, requestId: 'stale' }, work.id)).status).toBe(409);
});
test('strict bounded JSON and query validation fail before any time record can be written', async () => {
  const table = routes(), { work, command } = checkedWork();
  for (const suffix of ['?timezone=UTC', `${query()}&timezone=UTC`, `${query()}&raw=true`, '?start=0&end=1&timezone=invalid', '?start=&end=1&timezone=UTC']) expect((await call(table, base, 'GET', suffix)).status).toBe(400);
  for (const suffix of ['?timezone=UTC&at=', '?timezone=UTC&at=NaN', '?timezone=UTC&at=9999999999999']) expect((await call(table, `${base}/summary`, 'GET', suffix)).status).toBe(400);
  for (const raw of [{ ...command, qualification: 'measured' }, { ...command, baseline: { ...command.baseline, minutes: -1 } }, []]) expect((await call(table, timePath, 'POST', '', raw, work.id)).status).toBe(400);
  for (const body of ['{', new Uint8Array([0xff]), 'x'.repeat(32769)]) {
    const req = Object.assign(new Request('http://localhost', { method: 'POST', body }), { params: { id: work.id } });
    expect((await table[timePath].POST(req)).status).toBe(400);
  }
  expect(getDb().query('SELECT * FROM outcome_time_record').all()).toEqual([]);
});
test('authenticated socket requires a session for reads/writes and returns the same durable time receipt', async () => {
  const { work, command } = checkedWork(), dir = mkdtempSync(join(tmpdir(), 'jarvis-f16-http-')), socket = join(dir, 'api.sock');
  const server = new WebSocketServer(0, socket), sessions = new PanelSessionStore();
  server.setSidecarManager({ openPanelSession: async (token: string) => token === 'fixture-access' ? sessions.create('fixture') : null,
    resolvePanelSession: (value: string) => sessions.get(value) } as SidecarManager);
  server.setApiRoutes(routes()); const path = timePath.replace(':id', work.id);
  const send = (path: string, init: RequestInit = {}) => fetch(`http://localhost${path}`, { ...init, unix: socket });
  try {
    server.start(); expect((await send(`${base}${query()}`)).status).toBe(401);
    expect((await send(path, { method: 'POST', body: JSON.stringify(command) })).status).toBe(401);
    expect((await send(path)).status).toBe(401);
    const bootstrap = await send(`${base}?token=fixture-access`, { redirect: 'manual' });
    const headers = { Cookie: bootstrap.headers.get('set-cookie')!.split(';')[0]!, 'Content-Type': 'application/json' };
    const saved = await send(path, { method: 'POST', headers, body: JSON.stringify(command) }); expect(saved.status).toBe(200);
    const receipt = await saved.json();
    const current = await send(path, { headers }); expect(current.status).toBe(200);
    expect((await current.json() as any).record).toEqual(receipt);
    expect((await (await send(`${path}?requestId=http-time`, { headers })).json() as any).receipt).toEqual(receipt);
    expect((await (await send(`${base}/summary?timezone=UTC`, { headers })).json() as any).data.week.value).toBe(10);
  } finally { server.stop(); rmSync(dir, { recursive: true, force: true }); }
});


test('F16 review R2: a fresh client can refresh current time evidence and correct a concurrent revision', async () => {
  const table = routes(), { work, command } = checkedWork();
  const current = () => call(table, timePath, 'GET', '', undefined, work.id);
  expect(await current()).toMatchObject({ status: 200, body: { record: null } });
  const first = await call(table, timePath, 'POST', '', command, work.id);
  const firstView = await current(); expect(firstView.body.record).toEqual(first.body);
  const secondCommand = { ...command, requestId: 'second-client', revision: 1, baseline: { ...command.baseline, minutes: 20 } };
  const second = await call(table, timePath, 'POST', '', secondCommand, work.id);
  const stale = { ...command, requestId: 'correction', revision: firstView.body.record.revision };
  expect((await call(table, timePath, 'POST', '', stale, work.id)).status).toBe(409);
  const refreshed = await current(); expect(refreshed.body.record).toEqual(second.body);
  const corrected = await call(table, timePath, 'POST', '', { ...stale, revision: refreshed.body.record.revision }, work.id);
  expect(corrected.status).toBe(200); expect(corrected.body.revision).toBe(3);
  expect((await current()).body.record).toEqual(corrected.body);
  expect((await call(table, timePath, 'GET', '?requestId=http-time', undefined, work.id)).body.receipt).toEqual(first.body);
  for (const suffix of ['?requestId=', '?requestId=x&requestId=y', '?unexpected=true'])
    expect((await call(table, timePath, 'GET', suffix, undefined, work.id)).status).toBe(400);
});

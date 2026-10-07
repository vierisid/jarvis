import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initDatabase, closeDb, getDb } from '../vault/schema';
import { createEntity } from '../vault/entities';
import { createFact, deleteFact } from '../vault/facts';
import { MemoryStream } from '../brief/memory-stream';
import type { MemoryUsageReader } from '../brief/memory-stream-contracts';
import { BriefCapabilities, type BriefCapabilityId } from '../brief/capabilities';
import { registerMemoryStream } from '../brief/registrations/memory-stream';
import { createApiRoutes, type ApiContext } from './api-routes';
import { WebSocketServer } from '../comms/websocket';
import { PanelSessionStore } from '../sidecar/panel-sessions';
import type { SidecarManager } from '../sidecar/manager';

let provider: MemoryStream, usage: MemoryUsageReader, subject: string;
beforeEach(() => {
  initDatabase(':memory:', { quiet: true }); subject = createEntity('person', 'Ada').id;
  usage = { readiness: () => 'ready', readUses: () => ({ state: 'ready', uses: [] }) };
  provider = new MemoryStream(getDb(), usage);
});
afterEach(() => closeDb());
function routes(enabled: BriefCapabilityId[] = ['memoryStream', 'memoryUsage'], registered: MemoryStream | undefined = provider, registeredUsage: MemoryUsageReader | undefined = usage) {
  return createApiRoutes({ briefMemoryStream: provider, briefCapabilities: new BriefCapabilities([
    ...registerMemoryStream(registered), ...(registeredUsage ? [{ id: 'memoryUsage' as const, provider: registeredUsage }] : []),
  ], enabled) } as ApiContext) as Record<string, any>;
}
const base = '/api/brief/memory';
async function call(table = routes(), suffix = '', path = base, id = 'fact') {
  const req = Object.assign(new Request(`http://localhost${path.replace(':id', id)}${suffix}`), { params: { id } });
  const response = await table[path].GET(req); expect(response.headers.get('Cache-Control')).toBe('no-store');
  return { status: response.status, body: await response.json() };
}
test('provider absence, wrong instance, disabled flags and absent F18 all fail closed on every route', async () => {
  const noUsage = new MemoryStream(getDb());
  const withoutUsage = createApiRoutes({ briefMemoryStream: noUsage, briefCapabilities: new BriefCapabilities(registerMemoryStream(noUsage), ['memoryStream', 'memoryUsage']) } as ApiContext);
  for (const [table, status] of [[createApiRoutes({} as ApiContext), 501], [routes([], provider), 503], [routes(['memoryStream']), 503], [routes(['memoryUsage']), 503],
    [routes(undefined, new MemoryStream(getDb(), usage)), 501], [withoutUsage, 503], [routes(undefined, provider, { ...usage }), 503]] as const) {
    for (const path of [base, `${base}/:id`, `${base}/:id/history`]) expect((await call(table, '', path)).status).toBe(status);
  }
  const table = routes(); closeDb(); initDatabase(':memory:', { quiet: true });
  expect((await call(table)).status).toBe(503);
});
test('enabled collection, safe detail/history, no match, and missing detail have distinct responses', async () => {
  expect(await call()).toMatchObject({ status: 200, body: { state: 'empty', data: { count: { matched: 0 } } } });
  const fact = createFact(subject, 'likes', 'tea', { source: 'dashboard' });
  const list = await call(); expect(list.status).toBe(200); expect(list.body.data.items[0].sentence).toBe('Ada likes tea');
  const detail = await call(routes(), '', `${base}/:id`, fact.id); expect(detail.body.data.factId).toBe(fact.id);
  const history = await call(routes(), '', `${base}/:id/history`, fact.id); expect(history.body.data).toHaveLength(1);
  expect(await call(routes(), '?q=coffee')).toMatchObject({ status: 200, body: { state: 'empty', data: { count: { total: 1, matched: 0, returned: 0 } } } });
  expect((await call(routes(), '', `${base}/:id`, 'missing')).status).toBe(404);
  expect((await call(routes(), '?usedIn=conversation:a')).status).toBe(503);
});
test('stale pagination returns 409 without old fact content and exact filters must be repeated', async () => {
  const a = createFact(subject, 'likes', 'tea'); createFact(subject, 'likes', 'coffee'); const table = routes();
  const first = await call(table, '?limit=1'); const cursor = encodeURIComponent(first.body.data.nextCursor);
  expect((await call(table, `?cursor=${cursor}`)).status).toBe(400);
  deleteFact(a.id); expect(await call(table, `?limit=1&cursor=${cursor}`)).toEqual({ status: 409, body: { state: 'stale', reason: 'source_changed' } });
});
test('strict query and path validation reject duplicates, unknowns, blanks and oversized requests', async () => {
  for (const suffix of ['?q=x&q=y', '?secret=1', '?q=', '?limit=0', '?limit=101', '?limit=1.5', '?updatedFrom=1e3', '?updatedBefore=NaN', '?updatedFrom=2&updatedBefore=1', '?q=' + 'a'.repeat(257), '?source=' + 'a'.repeat(9000), '?cursor=garbage'])
    expect((await call(routes(), suffix)).status).toBe(400);
  for (const id of ['%2F', '%', '..', '%00']) expect((await call(routes(), '', `${base}/:id`, id)).status).toBe(400);
  expect((await call(routes(), '?q=x', `${base}/:id`)).status).toBe(400);
});
test('legacy fact routes still return canonical facts and preserve their independent behavior', async () => {
  const table = routes([]), f = createFact(subject, 'likes', 'tea');
  const response = await table['/api/vault/facts'].GET(new Request('http://localhost/api/vault/facts'));
  const records = await response.json(); expect(records[0].id).toBe(f.id); expect(records[0].evidence).toHaveLength(1);
  expect((await call(table)).status).toBe(503);
});
test('real socket authenticates list/detail/history and returns no-store projections only after session bootstrap', async () => {
  const f = createFact(subject, 'likes', 'tea'), dir = mkdtempSync(join(tmpdir(), 'jarvis-f17-http-')), socket = join(dir, 'api.sock');
  const server = new WebSocketServer(0, socket), sessions = new PanelSessionStore();
  server.setSidecarManager({ openPanelSession: async (token: string) => token === 'fixture-access' ? sessions.create('fixture') : null,
    resolvePanelSession: (value: string) => sessions.get(value) } as SidecarManager);
  server.setApiRoutes(routes());
  const send = (path: string, init: RequestInit = {}) => fetch(`http://localhost${path}`, { ...init, unix: socket });
  try {
    server.start();
    for (const path of [base, `${base}/${f.id}`, `${base}/${f.id}/history`]) expect((await send(path)).status).toBe(401);
    const bootstrap = await send(`${base}?token=fixture-access`, { redirect: 'manual' });
    const headers = { Cookie: bootstrap.headers.get('set-cookie')!.split(';')[0]! };
    for (const path of [base, `${base}/${f.id}`, `${base}/${f.id}/history`]) {
      const response = await send(path, { headers }); expect(response.status).toBe(200);
      expect(response.headers.get('Cache-Control')).toBe('no-store'); expect((await response.json() as any).state).toBe('ready');
    }
  } finally { server.stop(); rmSync(dir, { recursive: true, force: true }); }
});

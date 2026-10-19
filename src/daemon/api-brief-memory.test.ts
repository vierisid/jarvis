import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initDatabase, closeDb, getDb } from '../vault/schema';
import { createEntity } from '../vault/entities';
import { createFact, correctFact, deleteFact } from '../vault/facts';
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

for (const view of ['collection', 'detail', 'history'] as const) {
  test(`F17 review R1: ${view} retains canonical scope across independent confirmed preferences and correction`, async () => {
    const work = createFact(subject, 'preferred_editor', 'Vim', { confirmed: true, scope: 'work' });
    const personal = createFact(subject, 'preferred_editor', 'VS Code', { confirmed: true, scope: 'personal' });
    const unscoped = createFact(subject, 'preferred_editor', 'Other', { confirmed: true });
    const corrected = correctFact(work.id, 'Emacs', 'Updated work preference');
    const table = routes(), expected = [
      { factId: corrected.id, scope: 'work', status: 'active' },
      { factId: personal.id, scope: 'personal', status: 'active' },
      { factId: unscoped.id, scope: '', status: 'active' },
    ];
    if (view === 'collection') {
      const response = await call(table); expect(response.status).toBe(200);
      expect(response.body.data.count).toEqual({ total: 3, matched: 3, returned: 3 });
      for (const item of expected) expect(response.body.data.items.find((f: any) => f.factId === item.factId)).toMatchObject({ ...item, basis: 'confirmed' });
    } else if (view === 'detail') {
      for (const item of [...expected, { factId: work.id, scope: 'work', status: 'superseded' }]) {
        const response = await call(table, '', `${base}/:id`, item.factId); expect(response.status).toBe(200);
        expect(response.body.data).toMatchObject({ ...item, basis: 'confirmed' });
      }
    } else {
      const response = await call(table, '', `${base}/:id/history`, corrected.id); expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(2);
      expect(response.body.data.find((f: any) => f.factId === work.id)).toMatchObject({ scope: 'work', status: 'superseded' });
      expect(response.body.data.find((f: any) => f.factId === corrected.id)).toMatchObject({ scope: 'work', status: 'active' });
      for (const item of expected.slice(1)) {
        const own = await call(table, '', `${base}/:id/history`, item.factId); expect(own.body.data).toHaveLength(1);
        expect(own.body.data[0]).toMatchObject(item);
      }
    }
  });
}
for (const kind of ['canonical', 'evidence'] as const) {
  for (const [name, source] of [['spaces', ' meeting '], ['nonbreaking spaces', '\u00a0meeting\u00a0'], ['tabs/newlines', '\tmeeting\n']] as const) {
    test(`F17 review R2: ${kind} Source with ${name} round-trips through exact filters, counts and cursors`, async () => {
      const ids = ['tea', 'coffee'].map(object => {
        const row = createFact(subject, 'likes', object, { source: kind === 'canonical' ? source : 'import' });
        if (kind === 'evidence') createFact(subject, 'likes', object, { source });
        return row.id;
      });
      const plain = createFact(subject, 'likes', 'water', { source: 'meeting' }), table = routes();
      const all = await call(table);
      const label = all.body.data.items.find((f: any) => f.factId === ids[0]).sourceSummary.labels.find((value: string) => value === source);
      expect(label).toBe(source);
      const query = new URLSearchParams({ source: label, limit: '1' });
      const first = await call(table, `?${query}`); expect(first.status).toBe(200);
      expect(first.body.data.count).toEqual({ total: 3, matched: 2, returned: 1 });
      query.set('cursor', first.body.data.nextCursor);
      const second = await call(table, `?${query}`); expect(second.status).toBe(200);
      expect(second.body.data.count).toEqual({ total: 3, matched: 2, returned: 1 });
      expect(second.body.data.nextCursor).toBeNull();
      expect([first.body.data.items[0].factId, second.body.data.items[0].factId].sort()).toEqual(ids.sort());
      const plainPage = await call(table, '?source=meeting'); expect(plainPage.status).toBe(200);
      expect(plainPage.body.data.items.map((f: any) => f.factId)).toEqual([plain.id]);
      query.set('source', 'meeting'); expect((await call(table, `?${query}`)).status).toBe(400);
    });
  }
}

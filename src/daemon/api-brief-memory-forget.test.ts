import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initDatabase, getDb, closeDb } from '../vault/schema';
import { createEntity } from '../vault/entities';
import { createFact, getFact, correctFact } from '../vault/facts';
import { MemoryForget } from '../brief/memory-forget';
import { registerMemoryForget } from '../brief/registrations/memory-forget';
import { BriefCapabilities } from '../brief/capabilities';
import { createApiRoutes, type ApiContext } from './api-routes';
import { WebSocketServer } from '../comms/websocket';
import { PanelSessionStore } from '../sidecar/panel-sessions';
import type { SidecarManager } from '../sidecar/manager';

let saved: string | undefined, service: MemoryForget, id: string;
beforeEach(() => { saved = process.env.JARVIS_BRIEF_MEMORY_FORGET; process.env.JARVIS_BRIEF_MEMORY_FORGET = '1'; initDatabase(':memory:', { quiet: true });
  service = new MemoryForget(getDb()); id = createFact(createEntity('person', 'Ada').id, 'note', 'PRIVATE forgotten fact').id; });
afterEach(() => { closeDb(); if (saved === undefined) delete process.env.JARVIS_BRIEF_MEMORY_FORGET; else process.env.JARVIS_BRIEF_MEMORY_FORGET = saved; });
const path = '/api/brief/memory/:id/forget';
function table(enabled = true, registered = service) {
  return createApiRoutes({ briefMemoryForget: service,
    briefCapabilities: new BriefCapabilities(registerMemoryForget(registered), enabled ? ['memoryForget'] : []) } as ApiContext) as Record<string, any>;
}
async function call(method = 'GET', body?: unknown, suffix = '', routes = table(), target = id) {
  const request = Object.assign(new Request(`http://localhost/api/brief/memory/${target}/forget${suffix}`, { method,
    ...(body === undefined ? {} : { body: body instanceof Uint8Array ? Buffer.from(body) : typeof body === 'string' ? body : JSON.stringify(body) }) }), { params: { id: target } });
  const response = await routes[path][method](request);
  expect(response.headers.get('Cache-Control')).toBe('no-store'); return { status: response.status, body: await response.json() };
}
async function command() { const result = await call(); return { requestId: 'forget-request', expectedRevision: result.body.revision, confirmed: true }; }
test('prepare and cancel do not mutate; confirmed POST and repeated POST return the same content-free receipt', async () => {
  const input = await command(); expect(getFact(id)).not.toBeNull();
  expect((await call('POST', { ...input, confirmed: false })).status).toBe(400); expect(getFact(id)).not.toBeNull();
  const result = await call('POST', input); expect(result.status).toBe(200); expect(result.body.replayed).toBe(false);
  expect(getFact(id)).toBeNull(); expect(await call('POST', input)).toMatchObject({ status: 200, body: { replayed: true, receipt: result.body.receipt } });
  expect(await call()).toMatchObject({ status: 200, body: { state: 'forgotten', receipt: result.body.receipt } });
  expect(JSON.stringify(result)).not.toContain('PRIVATE');
});
test('unknown, stale, malformed, oversized and ambiguous requests cannot delete', async () => {
  const input = await command();
  expect((await call('GET', undefined, '', table(), 'missing')).status).toBe(404);
  for (const invalid of [null, [], {}, { ...input, extra: true }, { ...input, confirmed: 'true' }, '{', new Uint8Array([0xff])]) {
    expect((await call('POST', invalid)).status).toBe(400);
  }
  expect((await call('POST', 'x'.repeat(2049))).status).toBe(413);
  expect((await call('POST', input, '?confirmed=true')).status).toBe(400);
  expect((await call('GET', undefined, '', table(), '%')).status).toBe(400);
  expect((await call('POST', { ...input, expectedRevision: '0'.repeat(64) })).status).toBe(409); expect(getFact(id)).not.toBeNull();
  correctFact(id, 'Corrected value', 'Correction won the race');
  expect((await call('POST', input)).status).toBe(409);
});
test('missing, mismatched, disabled and foreign-vault providers fail closed without depending on F18 activation', async () => {
  expect((await call('GET', undefined, '', createApiRoutes({} as ApiContext))).status).toBe(501);
  expect((await call('GET', undefined, '', table(true, new MemoryForget(getDb())))).status).toBe(501);
  expect((await call('GET', undefined, '', table(false))).status).toBe(503);
  delete process.env.JARVIS_BRIEF_MEMORY_FORGET; expect((await call()).status).toBe(503);
  process.env.JARVIS_BRIEF_MEMORY_FORGET = '1'; expect((await call()).status).toBe(200);
  const routes = table(); closeDb(); initDatabase(':memory:', { quiet: true }); expect((await call('GET', undefined, '', routes)).status).toBe(503);
});
test('Forget GET and POST require real HTTP panel authentication', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-f19-http-')), socket = join(directory, 'api.sock');
  const server = new WebSocketServer(0, socket), sessions = new PanelSessionStore();
  server.setSidecarManager({ openPanelSession: async (token: string) => token === 'fixture-access' ? sessions.create('fixture') : null,
    resolvePanelSession: (value: string) => sessions.get(value) } as SidecarManager);
  server.setApiRoutes(table());
  const send = (suffix = '', init: RequestInit = {}) => fetch(`http://localhost/api/brief/memory/${id}/forget${suffix}`, { ...init, unix: socket });
  try {
    server.start();
    expect((await send()).status).toBe(401); expect((await send('', { method: 'POST', body: JSON.stringify(await command()) })).status).toBe(401);
    const bootstrap = await send('?token=fixture-access', { redirect: 'manual' });
    const headers = { Cookie: bootstrap.headers.get('set-cookie')!.split(';')[0]! };
    const prepare = await send('', { headers }); expect(prepare.status).toBe(200); expect(getFact(id)).not.toBeNull();
    const input = { requestId: 'authenticated-forget', expectedRevision: (await prepare.json() as any).revision, confirmed: true };
    const response = await send('', { headers, method: 'POST', body: JSON.stringify(input) });
    expect(response.status).toBe(200); expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect((await response.json() as any).state).toBe('forgotten'); expect(getFact(id)).toBeNull();
  } finally { server.stop(); rmSync(directory, { recursive: true, force: true }); }
});

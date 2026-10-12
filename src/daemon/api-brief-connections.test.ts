import { setEncryptionKey } from '../workflows/db/encryption';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createApiRoutes, type ApiContext } from './api-routes';
import { ConnectedWorkspace } from '../brief/connected-workspace';
import { BriefCapabilities } from '../brief/capabilities';
import { registerConnections } from '../brief/registrations/connections';
import { initWorkflowDb, closeWorkflowDb, getWorkflowDb, DEFAULT_IDS } from '../workflows/db';
import { createWorkflowRoutes } from '../workflows/api/routes';
import { getConnection, upsertConnection } from '../workflows/db/repos/app-connection';
import { WebSocketServer } from '../comms/websocket';
import { PanelSessionStore } from '../sidecar/panel-sessions';
import type { SidecarManager } from '../sidecar/manager';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConnectionSetup } from '../../ui/src/brief/connections/setup';
let provider: ConnectedWorkspace, flag: string | undefined;
const path = '/api/brief/connections';
beforeEach(() => { flag = process.env.JARVIS_BRIEF_CONNECTIONS; process.env.JARVIS_BRIEF_CONNECTIONS = '1'; setEncryptionKey(Buffer.alloc(32, 22)); initWorkflowDb(':memory:'); provider = new ConnectedWorkspace(getWorkflowDb(), { hosted: () => false,
  channels: () => ({ telegram: { enabled: true, connected: true, authentication: 'verified' } }) }); });
afterEach(() => { closeWorkflowDb(); setEncryptionKey(null); if (flag === undefined) delete process.env.JARVIS_BRIEF_CONNECTIONS; else process.env.JARVIS_BRIEF_CONNECTIONS = flag; });
function routes(enabled = true, registered = provider) {
  return createApiRoutes({ briefConnections: provider, briefCapabilities: new BriefCapabilities(registerConnections(registered), enabled ? ['connections'] : []) } as ApiContext) as Record<string, any>;
}
test('requires exact provider, capability, flag and server-owned scope; never cache errors or data', async () => {
  for (const r of [routes(false), routes(true, new ConnectedWorkspace(getWorkflowDb(), { hosted: () => false })), createApiRoutes({} as ApiContext) as any]) {
    const res = await r[path].GET(new Request('http://localhost'+path)); expect([501,503]).toContain(res.status); expect(res.headers.get('Cache-Control')).toBe('no-store');
  }
  expect((await routes()[path].GET(new Request('http://localhost'+path+'?projectId=foreign'))).status).toBe(400);
  delete process.env.JARVIS_BRIEF_CONNECTIONS;
  expect((await routes()[path].GET(new Request('http://localhost'+path))).status).toBe(503);
});
test('actual authenticated HTTP contract feeds the setup adapter and refuses anonymous inspection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'f22-http-')), socket = join(dir, 'api.sock');
  const server = new WebSocketServer(0, socket), sessions = new PanelSessionStore();
  server.setSidecarManager({ openPanelSession: async (token: string) => token === 'fixture' ? sessions.create('device') : null, resolvePanelSession: (s: string) => sessions.get(s) } as SidecarManager);
  server.setApiRoutes(routes());
  const send = (url: string, init: RequestInit = {}) => fetch('http://localhost'+url, { ...init, unix: socket });
  try {
    server.start(); expect((await send(path)).status).toBe(401);
    const bootstrap = await send(path+'?token=fixture', { redirect: 'manual' });
    const headers = { Cookie: bootstrap.headers.get('set-cookie')!.split(';')[0]! };
    const read = async () => { const r = await send(path, { headers }); expect(r.status).toBe(200); expect(r.headers.get('Cache-Control')).toBe('no-store'); return ((await r.json()) as any).data; };
    let stored = '', opens = 0;
    const controller = new ConnectionSetup(DEFAULT_IDS.project, { read, storage: { getItem: () => stored || null, setItem: (_,v) => { stored=v; } }, nonce: () => 'fixture-state', open: () => { opens++; } });
    await controller.begin('setup:telegram', { search: 'tele', anchorId: 'channel:telegram', scrollTop: 54 }, 'channel:telegram');
    expect((await controller.verify('fixture-state'))?.result).toBe('connected'); expect(opens).toBe(1);
    expect(stored).not.toContain('connected');
  } finally { server.stop(); rmSync(dir, { recursive: true, force: true }); }
});
test('canonical manual credential routes preserve main project isolation and do not resurrect deleted secrets', async () => {
  const a = upsertConnection({ externalId: 'same', displayName: 'First', pieceName: 'fixture', pieceVersion: '1', type: 'SECRET_TEXT', value: { secret_text: 'fixture' } });
  const b = upsertConnection({ externalId: 'same', displayName: 'Foreign', pieceName: 'fixture', pieceVersion: '1', type: 'SECRET_TEXT', value: { secret_text: 'foreign' }, projectId: 'foreign' });
  const table = createWorkflowRoutes() as Record<string, any>;
  const byId = table['/api/workflows/connections/:id'];
  const req = (id: string, method: string, body?: unknown) => Object.assign(new Request('http://localhost/api/workflows/connections/'+id, { method, ...(body ? { body: JSON.stringify(body) } : {}) }), { params: { id } });
  expect((await byId.PATCH(req(b.id, 'PATCH', { displayName: 'Changed' }))).status).toBe(404);
  expect((await byId.DELETE(req(b.id, 'DELETE'))).status).toBe(404);
  expect(getConnection(b.id)?.displayName).toBe('Foreign');
  const racing = Object.assign(new Request('http://localhost/api/workflows/connections/'+a.id, { method: 'PATCH', body: new ReadableStream({ pull(controller) {
    getWorkflowDb().run('DELETE FROM app_connection WHERE id=?', [a.id]); controller.enqueue(new TextEncoder().encode('{"displayName":"Changed"}')); controller.close();
  } }) }), { params: { id: a.id } });
  expect((await byId.PATCH(racing)).status).toBe(404); expect(getConnection(a.id)).toBeNull();
  expect(getWorkflowDb().query('SELECT id FROM app_connection').all()).toHaveLength(1);
});

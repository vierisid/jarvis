import { expect, test } from 'bun:test';
import { createApiRoutes, type ApiContext } from './api-routes.ts';
import { BriefCapabilities } from '../brief/capabilities.ts';
import { WebSocketServer } from '../comms/websocket.ts';
import { PanelSessionStore } from '../sidecar/panel-sessions.ts';
import type { SidecarManager } from '../sidecar/manager.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { closeDb, getDb, initDatabase } from '../vault/schema.ts';
import { addMessage, getOrCreateConversation, getRecentConversation } from '../vault/conversations.ts';

type Route = { GET: (req: Request) => Response | Promise<Response> };

test('Brief capabilities are registered with every feature disabled by default', async () => {
  const routes = createApiRoutes({} as ApiContext);
  const route = routes['/api/brief/capabilities'] as { GET: () => Response } | undefined;
  expect(route).toBeDefined();
  const response = route!.GET();
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const body = await response.json() as {
    contractVersion: number;
    capabilities: Record<string, { supported: boolean; ready: boolean; enabled: boolean }>;
  };
  expect(body.contractVersion).toBe(1);
  expect(Object.keys(body.capabilities)).toHaveLength(26);
  for (const capability of Object.values(body.capabilities)) {
    expect(capability).toMatchObject({ supported: false, ready: false, enabled: false });
  }
});

test('capability endpoint is protected by the real session gate, including after session expiry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-f-01-http-'));
  const socket = join(dir, 'api.sock');
  const server = new WebSocketServer(0, socket);
  let now = 1_000;
  const sessions = new PanelSessionStore({ now: () => now });
  const manager: Pick<SidecarManager, 'openPanelSession' | 'resolvePanelSession'> = {
    openPanelSession: async token => token === 'fixture-access' ? sessions.create('fixture-sidecar') : null,
    resolvePanelSession: id => sessions.get(id),
  };
  const routes = createApiRoutes({} as ApiContext) as Record<string, Route>;
  server.setSidecarManager(manager as SidecarManager);
  server.setApiRoutes(routes);
  const get = (path: string, options: RequestInit = {}) => fetch(`http://localhost${path}`, { ...options, unix: socket });
  try {
    server.start();
    expect((await get('/api/brief/capabilities')).status).toBe(401);
    expect((await get('/api/brief/capabilities', { headers: { Cookie: 'panel_session=invalid' } })).status).toBe(401);
    expect((await get('/api/brief/capabilities', { headers: { Authorization: 'Bearer fixture-access' } })).status).toBe(401);
    const bootstrap = await get('/api/brief/capabilities?token=fixture-access', { redirect: 'manual' });
    expect(bootstrap.status).toBe(302);
    expect(bootstrap.headers.get('location')).toBe('/api/brief/capabilities');
    const cookie = bootstrap.headers.get('set-cookie')!.split(';')[0]!;
    const response = await get('/api/brief/capabilities', { headers: { Cookie: cookie } });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect((await response.json() as { contractVersion: number }).contractVersion).toBe(1);
    expect((await get('/api/brief/capabilities', { method: 'POST', headers: { Cookie: cookie } })).status).toBe(405);
    now += 13 * 60 * 60 * 1000;
    expect((await get('/api/brief/capabilities', { headers: { Cookie: cookie } })).status).toBe(401);
  } finally {
    server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('API exposes live sanitized readiness using the injected provider registry', async () => {
  let ready = true;
  const briefCapabilities = new BriefCapabilities([{
    id: 'conversations', provider: { readiness: () => { if (!ready) throw new Error('private credential'); return 'ready'; } },
  }], ['conversations']);
  const routes = createApiRoutes({ briefCapabilities } as ApiContext);
  const route = routes['/api/brief/capabilities'] as Route;
  const request = new Request('http://localhost/api/brief/capabilities');
  expect(await (await route.GET(request)).json()).toMatchObject({ capabilities: { conversations: { enabled: true } } });
  ready = false;
  const response = await route.GET(request);
  const body = await response.text();
  expect(body).not.toContain('private credential');
  expect(JSON.parse(body)).toMatchObject({ capabilities: { conversations: { enabled: false, state: 'unavailable' } } });
});

test('old conversation client sees unchanged payloads and stored history after a capability read', async () => {
  initDatabase(':memory:', { quiet: true });
  try {
    const conversation = getOrCreateConversation('websocket');
    addMessage(conversation.id, { role: 'user', content: 'Keep this history' });
    const expected = getRecentConversation('websocket');
    const schemaBefore = getDb().query('SELECT name, sql FROM sqlite_master ORDER BY name').all();
    const routes = createApiRoutes({} as ApiContext) as Record<string, Route>;
    const active = routes['/api/vault/conversations/active']!;
    const request = new Request('http://localhost/api/vault/conversations/active?channel=websocket');
    expect(await (await active.GET(request)).json()).toEqual(expected);
    await routes['/api/brief/capabilities']!.GET(new Request('http://localhost/api/brief/capabilities'));
    expect(await (await active.GET(request)).json()).toEqual(expected);
    expect(getDb().query('SELECT name, sql FROM sqlite_master ORDER BY name').all()).toEqual(schemaBefore);
    expect(getOrCreateConversation('websocket').id).toBe(conversation.id);
    expect(await (await active.GET(new Request('http://localhost/api/vault/conversations/active?channel=missing'))).json())
      .toEqual({ conversation: null, messages: [] });
  } finally { closeDb(); }
});

import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApiRoutes, type ApiContext } from './api-routes.ts';
import { WebSocketServer } from '../comms/websocket.ts';
import { PanelSessionStore } from '../sidecar/panel-sessions.ts';
import type { SidecarManager } from '../sidecar/manager.ts';
import { BriefConversationProvider } from '../brief/conversations.ts';
import { createBriefCapabilities } from '../brief/registrations/index.ts';
import { registerConversations } from '../brief/registrations/conversations.ts';
import { ConversationRepository } from '../vault/conversation-lifecycle.ts';
import { initDatabase, closeDb, getDb } from '../vault/schema.ts';
import { addMessage, getOrCreateConversation } from '../vault/conversations.ts';
import type { BriefConversation } from '../brief/contracts.ts';

async function withApi(enabled: boolean, check: (fixture: {
  request: (path: string, method?: string, data?: unknown, authenticated?: boolean) => Promise<Response>;
  provider: BriefConversationProvider;
}) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-f02-api-')); const socket = join(dir, 'api.sock');
  initDatabase(':memory:', { quiet: true });
  const provider = new BriefConversationProvider();
  const sessions = new PanelSessionStore(); const session = sessions.create('fixture-sidecar');
  const manager = { resolvePanelSession: (id: string) => sessions.get(id), openPanelSession: async () => null };
  const server = new WebSocketServer(0, socket);
  server.setSidecarManager(manager as unknown as SidecarManager);
  const routes = createApiRoutes({
    briefConversations: provider,
    briefCapabilities: createBriefCapabilities(registerConversations(provider), enabled ? ['conversations'] : []),
  } as ApiContext) as Parameters<WebSocketServer['setApiRoutes']>[0];
  server.setApiRoutes(routes);
  const request = (path: string, method = 'GET', data?: unknown, authenticated = true) => fetch(`http://localhost${path}`, {
    unix: socket, method,
    headers: { ...(authenticated ? { Cookie: `panel_session=${session.id}` } : {}), 'Content-Type': 'application/json' },
    body: data === undefined ? undefined : typeof data === 'string' ? data : JSON.stringify(data),
  });
  try { server.start(); await check({ request, provider }); }
  finally { server.stop(); closeDb(); rmSync(dir, { recursive: true, force: true }); }
}

test('older API callers without a conversation provider receive unsupported without touching a vault', async () => {
  closeDb();
  const routes = createApiRoutes({} as ApiContext) as Record<string, { GET: (req: Request) => Promise<Response>; POST: (req: Request) => Promise<Response> }>;
  const read = await routes['/api/brief/conversations']!.GET(new Request('http://localhost/api/brief/conversations'));
  const write = await routes['/api/brief/conversations']!.POST(new Request('http://localhost/api/brief/conversations', { method: 'POST', body: '{invalid' }));
  expect(read.status).toBe(501); expect(write.status).toBe(501);
  expect(await read.json()).toEqual({ state: 'unsupported' });
});

test('conversation provider is discoverable but explicit lifecycle routes stay disabled by default', async () => {
  await withApi(false, async ({ request, provider }) => {
    const capabilities = await (await request('/api/brief/capabilities')).json() as any;
    expect(capabilities.capabilities.conversations).toMatchObject({ supported: true, ready: true, enabled: false, reason: 'disabled' });
    expect(capabilities.capabilities.chatTransport.enabled).toBe(false);
    for (const [path, method, data] of [
      ['/api/brief/conversations', 'GET', undefined],
      ['/api/brief/conversations', 'POST', '{malformed'],
      ['/api/brief/conversations/unknown/tab', 'PATCH', { open: true }],
    ] as const) {
      const result = await request(path, method, data);
      expect(result.status).toBe(503);
      expect(await result.json()).toMatchObject({ state: 'unavailable', reason: 'disabled' });
    }
    expect(provider.repository.list().items).toEqual([]);
  });
});

test('real panel authentication protects all lifecycle writes and there is no delete action', async () => {
  await withApi(true, async ({ request }) => {
    expect((await request('/api/brief/conversations', 'GET', undefined, false)).status).toBe(401);
    expect((await request('/api/brief/conversations', 'POST', { title: 'No access' }, false)).status).toBe(401);
    const created = await request('/api/brief/conversations', 'POST', { title: 'First' });
    expect(created.status).toBe(201);
    expect(created.headers.get('cache-control')).toBe('no-store');
    const a = await created.json() as BriefConversation;
    expect((await request(`/api/brief/conversations/${a.conversationId}`, 'DELETE')).status).toBe(405);
    expect((await request(`/api/brief/conversations/${a.conversationId}`, 'GET')).status).toBe(200);
  });
});

test('HTTP create/get/rename/tab order/active/close/reopen retain each conversation history', async () => {
  await withApi(true, async ({ request }) => {
    const a = await (await request('/api/brief/conversations', 'POST', { title: 'First' })).json() as BriefConversation;
    const b = await (await request('/api/brief/conversations', 'POST', {})).json() as BriefConversation;
    addMessage(a.conversationId, { role: 'user', content: 'First history' });
    addMessage(b.conversationId, { role: 'assistant', content: 'Second history' });
    const renamed = await request(`/api/brief/conversations/${a.conversationId}`, 'PATCH', { title: 'Renamed', revision: a.revision });
    expect(renamed.status).toBe(200);
    expect((await renamed.json() as BriefConversation).title).toBe('Renamed');
    expect((await request(`/api/brief/conversations/${a.conversationId}`, 'PATCH', { title: 'Lost edit', revision: a.revision })).status).toBe(409);
    expect((await request('/api/brief/conversations/tabs', 'PUT', { order: [b.conversationId, a.conversationId] })).status).toBe(200);
    expect((await request('/api/brief/conversations/active', 'PUT', { conversationId: a.conversationId })).status).toBe(200);
    const closed = await request(`/api/brief/conversations/${a.conversationId}/tab`, 'PATCH', { open: false });
    expect((await closed.json() as BriefConversation).tab).toEqual({ open: false, order: 1 });
    const state = await (await request('/api/brief/conversations/tabs')).json() as any;
    expect(state.activeConversationId).toBe(b.conversationId);
    const history = await (await request('/api/brief/conversations?closed=true')).json() as any;
    expect(history.items.map((v: BriefConversation) => v.conversationId)).toEqual([a.conversationId]);
    await request(`/api/brief/conversations/${a.conversationId}/tab`, 'PATCH', { open: true });
    const restored = await (await request(`/api/brief/conversations/${a.conversationId}`)).json() as BriefConversation;
    expect(restored).toMatchObject({ title: 'Renamed', tab: { open: true, order: 1 } });
    for (const [conversation, content] of [[a, 'First history'], [b, 'Second history']] as const) {
      const messages = await (await request(`/api/brief/conversations/${conversation.conversationId}/messages`)).json() as any;
      expect(messages.items.map((m: { content: string }) => m.content)).toEqual([content]);
    }
  });
});

test('foreign and unknown IDs are hidden through both lifecycle and legacy HTTP readers', async () => {
  await withApi(true, async ({ request, provider }) => {
    const mine = provider.repository.create();
    const foreign = new ConversationRepository(getDb(), 'fixture-foreign');
    const other = foreign.create({ title: 'Private foreign title' });
    addMessage(other.conversationId, { role: 'user', content: 'Private foreign history' });
    for (const id of ['unknown', other.conversationId]) {
      for (const path of [`/api/brief/conversations/${id}`, `/api/brief/conversations/${id}/messages`, `/api/vault/conversations/${id}/messages`]) {
        const result = await request(path);
        expect(result.status).toBe(404);
        expect(await result.json()).toEqual({ error: 'Conversation not found' });
      }
      expect((await request(`/api/brief/conversations/${id}`, 'PATCH', { title: 'Overwrite' })).status).toBe(404);
      expect((await request(`/api/brief/conversations/${id}/tab`, 'PATCH', { open: true })).status).toBe(404);
      expect((await request('/api/brief/conversations/active', 'PUT', { conversationId: id })).status).toBe(404);
    }
    const legacy = await (await request('/api/vault/conversations?channel=all')).json() as Array<{ id: string }>;
    expect(legacy.map(v => v.id)).toEqual([mine.conversationId]);
    expect((await request('/api/brief/conversations', 'POST', { workspaceId: 'fixture-foreign', title: 'No' })).status).toBe(400);
    expect((await request('/api/brief/conversations?workspaceId=fixture-foreign')).status).toBe(400);
    expect(foreign.get(other.conversationId).title).toBe('Private foreign title');
  });
});

test('HTTP pagination preserves equal-timestamp messages and rejects invalid inputs', async () => {
  await withApi(true, async ({ request, provider }) => {
    const a = provider.repository.create();
    for (const id of ['message-1', 'message-2', 'message-3']) {
      getDb().run('INSERT INTO conversation_messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)', [id, a.conversationId, 'user', id, 123]);
    }
    const path = `/api/brief/conversations/${a.conversationId}/messages`;
    const first = await (await request(`${path}?limit=2`)).json() as any;
    expect(first.items.map((m: { id: string }) => m.id)).toEqual(['message-2', 'message-3']);
    const next = await (await request(`${path}?limit=2&cursor=${first.nextCursor}`)).json() as any;
    expect(next.items.map((m: { id: string }) => m.id)).toEqual(['message-1']);
    expect(next.nextCursor).toBeNull();
    for (const query of ['limit=-1', 'limit=101', 'limit=1.2', 'limit=2&limit=3', 'cursor=invalid']) expect((await request(`${path}?${query}`)).status).toBe(400);
    for (const data of ['{', [], { title: 4 }, { title: '' }, { title: 'x'.repeat(161) }, { open: true }]) expect((await request('/api/brief/conversations', 'POST', data)).status).toBe(400);
    expect((await request('/api/brief/conversations', 'POST', ' '.repeat(16_385))).status).toBe(413);
    expect((await request(`/api/brief/conversations/${a.conversationId}/tab`, 'PATCH', { open: 'true' })).status).toBe(400);
  });
});

test('legacy websocket clients still restore their latest channel chat after explicit chat activity', async () => {
  await withApi(true, async ({ request, provider }) => {
    const legacy = getOrCreateConversation('websocket');
    addMessage(legacy.id, { role: 'user', content: 'Existing chat' });
    const explicit = provider.repository.create();
    addMessage(explicit.conversationId, { role: 'user', content: 'Separate chat' });
    const restored = await (await request('/api/vault/conversations/active?channel=websocket')).json() as any;
    expect(restored.conversation.id).toBe(legacy.id);
    expect(restored.messages.map((m: { content: string }) => m.content)).toEqual(['Existing chat']);
  });
});

test('provider errors are safe unavailable results and replacing the vault invalidates the provider', async () => {
  await withApi(true, async ({ request, provider }) => {
    provider.repository.list = () => { throw new Error('secret://internal-error'); };
    const failed = await request('/api/brief/conversations');
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ state: 'unavailable', reason: 'provider_unavailable' });
    closeDb();
    const closed = await request('/api/brief/conversations', 'POST', { title: 'No stale vault' });
    expect(closed.status).toBe(503);
    const capabilities = await (await request('/api/brief/capabilities')).json() as any;
    expect(capabilities.capabilities.conversations).toMatchObject({ supported: true, ready: false, enabled: false });
  });
});

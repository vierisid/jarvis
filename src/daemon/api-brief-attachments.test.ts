import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApiRoutes, type ApiContext } from './api-routes';
import { WebSocketServer } from '../comms/websocket';
import { PanelSessionStore } from '../sidecar/panel-sessions';
import type { SidecarManager } from '../sidecar/manager';
import { BriefAttachmentProvider } from '../brief/attachments';
import { BriefConversationProvider } from '../brief/conversations';
import { BriefChatTransport } from '../brief/chat-transport';
import { BriefCapabilities } from '../brief/capabilities';
import { registerChatAttachments } from '../brief/registrations/chat-attachments';
import { registerChatTransport } from '../brief/registrations/chat-transport';
import { registerConversations } from '../brief/registrations/conversations';
import { createAttachmentRoutes } from '../brief/attachment-routes';
import { initDatabase, closeDb, getDb } from '../vault/schema';
import { ATTACHMENT_LIMITS } from '../brief/attachment-contracts';

test('real panel authentication protects upload/read/remove/capture and metadata never discloses bytes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-f05-api-')), socket = join(dir, 'api.sock');
  initDatabase(':memory:', { quiet: true });
  const files = new BriefAttachmentProvider(getDb()), chats = new BriefConversationProvider();
  const transport = new BriefChatTransport({ db: getDb(), runner: { ready: () => true, stream() { throw Error('No model in API fixture'); } }, send() {} });
  const caps = new BriefCapabilities([...registerConversations(chats), ...registerChatTransport(transport), ...registerChatAttachments(files)], ['conversations', 'chatTransport', 'chatAttachments']);
  const sessions = new PanelSessionStore(), session = sessions.create('fixture-device');
  const server = new WebSocketServer(0, socket);
  server.setSidecarManager({ resolvePanelSession: (id: string) => sessions.get(id), openPanelSession: async () => null } as unknown as SidecarManager);
  server.setApiRoutes(createApiRoutes({ briefConversations: chats, briefAttachments: files, briefCapabilities: caps } as ApiContext) as Parameters<WebSocketServer['setApiRoutes']>[0]);
  const a = chats.repository.create().conversationId, b = chats.repository.create().conversationId;
  const base = `/api/brief/conversations/${a}/attachments/fixture`;
  const request = (path: string, method: string, body?: string | Uint8Array, authenticated = true) => fetch(`http://localhost${path}`, { unix: socket, method, body: body instanceof Uint8Array ? new Uint8Array(body).buffer : body,
    headers: { ...(authenticated ? { Cookie: `panel_session=${session.id}` } : {}), 'Content-Type': 'text/plain; charset=utf-8', 'X-Attachment-Name': 'fixture.txt', 'X-Attachment-Kind': 'document' } });
  try {
    server.start();
    for (const [suffix, method, body] of [['', 'PUT', 'private'], ['', 'GET', undefined], ['', 'DELETE', undefined], ['/capture', 'POST', '{}']]) {
      expect((await request(base + suffix, method!, body, false)).status).toBe(401);
    }
    expect(files.repository.find(a, 'fixture')).toBeNull();
    const uploaded = await request(base, 'PUT', 'PRIVATE UPLOADED BYTES');
    expect(uploaded.status).toBe(200); expect(uploaded.headers.get('Cache-Control')).toBe('no-store');
    const ref = await uploaded.json(); expect(ref).toMatchObject({ conversationId: a, attachmentId: 'fixture', state: 'ready' });
    expect(JSON.stringify(ref)).not.toContain('PRIVATE UPLOADED BYTES');
    expect(await (await request(base, 'PUT', 'PRIVATE UPLOADED BYTES')).json()).toEqual(ref);
    expect((await request(base, 'PUT', 'different')).status).toBe(409);
    expect((await request(base.replace(a, b), 'GET')).status).toBe(404);
    expect((await request(`${base}/capture`, 'POST', '{"deviceId":"absent","confirm":true}')).status).toBe(409);
    expect((await request(base.replace('fixture', 'too-large'), 'PUT', new Uint8Array(ATTACHMENT_LIMITS.documentBytes + 1))).status).toBe(413);
    expect((await request(base, 'DELETE')).status).toBe(200);
    expect((await request(base, 'PUT', 'PRIVATE UPLOADED BYTES')).status).toBe(409);
    transport.stop(); closeDb();
    expect((await request(base, 'GET')).status).toBe(503);
  } finally { if (files.readiness() === 'ready') transport.stop(); server.stop(); closeDb(); rmSync(dir, { recursive: true, force: true }); }
});

test('missing/default-off providers are unavailable; forged body lengths cannot evade the stream limit', async () => {
  initDatabase(':memory:', { quiet: true });
  try {
    const files = new BriefAttachmentProvider(getDb()); const c = files.repository.conversations.create().conversationId;
    const json = (body: unknown, status = 200) => Response.json(body, { status });
    const unsupported = createAttachmentRoutes(new BriefCapabilities([]), json);
    const request = Object.assign(new Request('http://localhost/attachment', { method: 'PUT', body: 'fixture', headers: { 'X-Attachment-Kind': 'document', 'X-Attachment-Name': 'fixture.txt', 'Content-Type': 'text/plain' } }), { params: { id: c, attachmentId: 'file' } });
    expect((await unsupported['/api/brief/conversations/:id/attachments/:attachmentId'].PUT(request)).status).toBe(501);
    const registrations = [...registerChatAttachments(files), { id: 'conversations' as const, provider: files }, { id: 'chatTransport' as const, provider: files }];
    const disabled = createAttachmentRoutes(new BriefCapabilities(registrations), json, files);
    expect((await disabled['/api/brief/conversations/:id/attachments/:attachmentId'].PUT(request)).status).toBe(503);
    const routes = createAttachmentRoutes(new BriefCapabilities(registrations, ['conversations', 'chatTransport', 'chatAttachments']), json, files);
    const oversized = Object.assign(new Request('http://localhost/attachment', { method: 'PUT', headers: { 'Content-Length': '1', 'X-Attachment-Kind': 'document', 'X-Attachment-Name': 'fixture.txt', 'Content-Type': 'text/plain' },
      body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(ATTACHMENT_LIMITS.documentBytes)); controller.enqueue(new Uint8Array(1)); controller.close(); } }), duplex: 'half' } as RequestInit), { params: request.params });
    expect((await routes['/api/brief/conversations/:id/attachments/:attachmentId'].PUT(oversized)).status).toBe(413);
    expect(files.repository.find(c, 'file')).toBeNull();
  } finally { closeDb(); }
});

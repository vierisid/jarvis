import { BriefAttachmentProvider } from '../../../../src/brief/attachments';
import { registerChatAttachments } from '../../../../src/brief/registrations/chat-attachments';
import { attachmentApi } from './attachments';
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDatabase, getDb, closeDb } from '../../../../src/vault/schema';
import { BriefConversationProvider } from '../../../../src/brief/conversations';
import { BriefChatTransport } from '../../../../src/brief/chat-transport';
import { createBriefRoutes } from '../../../../src/brief/routes';
import { BriefCapabilities } from '../../../../src/brief/capabilities';
import { registerConversations } from '../../../../src/brief/registrations/conversations';
import { registerChatTransport } from '../../../../src/brief/registrations/chat-transport';
import { registerChatState } from '../../../../src/brief/registrations/chat-state';
import type { WSMessage } from '../../../../src/comms/websocket';
import { conversationApi } from './api';
import { BriefConversationClient } from './client';

async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) { if (Date.now() > deadline) throw new Error('Integration fixture timed out'); await Bun.sleep(1); }
}

for (const withFiles of [false, true]) test(`real HTTP/WebSocket chat preserves history and attachment ownership (attachments=${withFiles})`, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-f04-'));
  const database = join(directory, 'fixture.sqlite');
  initDatabase(database, { quiet: true });
  const conversations = new BriefConversationProvider();
  const files = new BriefAttachmentProvider(getDb());
  const inputs: import('../../../../src/brief/chat-transport').ScopedChatInput[] = [];
  let executions = 0;
  const transport = new BriefChatTransport({ db: getDb(),
    runner: { ready: () => true, stream: input => {
      executions++; inputs.push(input);
      return { onComplete: async () => {}, stream: (async function* () {
        yield { type: 'text' as const, text: `Reply to ${input.text}` };
        yield { type: 'done' as const, response: { content: `Reply to ${input.text}`, tool_calls: [], usage: { input_tokens: 0, output_tokens: 0 }, model: 'fixture', finish_reason: 'stop' as const } };
      })() };
    } }, send: (socket, frame) => { socket.send(JSON.stringify(frame)); },
  });
  const capabilities = new BriefCapabilities([
    ...registerConversations(conversations), ...registerChatTransport(transport), ...registerChatState(conversations, transport), ...registerChatAttachments(files),
  ], ['conversations', 'chatTransport', 'chatState', ...(withFiles ? ['chatAttachments' as const] : [])]);
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0,
    routes: createBriefRoutes(capabilities, (body, status = 200) => Response.json(body, { status }), conversations, files),
    fetch(request, server) {
      if (new URL(request.url).pathname === '/ws' && server.upgrade(request)) return;
      return new Response('Not found', { status: 404 });
    },
    websocket: {
      message(socket, message) { void transport.handle(JSON.parse(String(message)) as WSMessage, socket, capabilities); },
      close(socket) { transport.detach(socket); },
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  const api = conversationApi((path, init) => fetch(`${base}${path}`, init));
  const saved = new Map<string, string>();
  const storage = { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => { saved.set(key, value); } };
  const client = new BriefConversationClient(api, storage, attachmentApi((path, init) => fetch(`${base}${path}`, init)));
  let socket: WebSocket | undefined;
  const connect = async () => {
    socket = new WebSocket(`${base.replace('http:', 'ws:')}/ws`);
    socket.onopen = () => client.adapter.onOpen(socket!);
    socket.onmessage = event => { client.adapter.onMessage(JSON.parse(String(event.data))); };
    socket.onclose = () => client.adapter.onClose();
    await until(() => client.getSnapshot().connected);
  };
  try {
    await client.start(); const a = await client.add(), b = await client.add(); await connect();
    await until(() => client.store.getSnapshot().conversations[a]?.history.state === 'ready');
    if (withFiles) await client.attachments.upload(a, 'document', new File(['A attachment secret'], 'a.txt', { type: 'text/plain' }));
    client.store.setDraft(a, 'A'); client.send(a, 'A');
    await until(() => Object.values(client.store.getSnapshot().conversations[a]!.turns).some(turn => turn.state === 'completed'));
    client.store.setDraft(b, 'B'); client.send(b, 'B');
    await until(() => Object.values(client.store.getSnapshot().conversations[b]!.turns).some(turn => turn.state === 'completed'));
    client.store.setDraft(a, 'Next A'); client.store.setScroll(a, { top: 120, atBottom: false });
    expect(client.store.getSnapshot().activeId).toBe(b);
    expect(client.store.getSnapshot().conversations[a]?.messages.map(m => m.content)).toEqual(['A', 'Reply to A']);
    expect(client.store.getSnapshot().conversations[b]?.messages.map(m => m.content)).toEqual(['B', 'Reply to B']);
    socket!.close(); await until(() => !client.getSnapshot().connected);
    await connect();
    await until(() => client.store.getSnapshot().conversations[a]?.sequence === transport.repository.sequence(a));
    await client.close(b); expect(client.store.getSnapshot().activeId).toBe(a);
    await client.reopen(b);
    expect(client.store.getSnapshot().conversations[b]?.messages).toHaveLength(2);
    expect(client.store.getSnapshot().conversations[a]?.draft).toBe('Next A');
    expect(executions).toBe(2);
    if (withFiles) {
      expect(JSON.stringify(inputs[0]?.attachmentContent)).toContain('A attachment secret');
      expect(inputs[1]?.attachmentContent).toBeUndefined();
      expect(client.store.getSnapshot().conversations[a]?.attachments).toEqual([]);
      expect(client.store.getSnapshot().conversations[a]?.messages[0]?.attachments?.[0]?.state).toBe('accepted');
      expect(JSON.stringify([...saved.values()])).not.toContain('A attachment secret');
    }
    const reloaded = new BriefConversationClient(api, storage, attachmentApi((path, init) => fetch(`${base}${path}`, init)));
    await reloaded.start();
    expect(reloaded.store.getSnapshot().activeId).toBe(b);
    expect(reloaded.store.getSnapshot().conversations[a]?.draft).toBe('Next A');
    expect(reloaded.store.getSnapshot().conversations[a]?.scroll.top).toBe(120);
    reloaded.stop();
  } finally {
    client.stop();
    if (socket) { socket.onclose = socket.onmessage = socket.onopen = null; socket.close(); }
    transport.stop(); await transport.idle(); await server.stop(true); closeDb();
    rmSync(directory, { recursive: true, force: true });
  }
});

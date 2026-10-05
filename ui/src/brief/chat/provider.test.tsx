import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { BriefCapabilities } from '../../../../src/brief/capabilities';
import { BriefConversationClient } from './client';
import type { ConversationApi } from './api';
import type { BriefConversation } from '../../../../src/brief/contracts';

let React: typeof import('react');
let createRoot: typeof import('react-dom/client').createRoot;
let Provider: typeof import('./provider').BriefConversationProvider;
let useChat: typeof import('./provider').useBriefConversation;
let observed: ReturnType<typeof useChat>;
let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
const sockets: FakeSocket[] = [];
const requests: string[] = [];
let originalFetch: typeof fetch, OriginalWebSocket: typeof WebSocket;
const tab: BriefConversation = { conversationId: 'chat-a', workspaceId: 'workspace', title: 'A', revision: '1', tab: { open: true, order: 0 }, lastMessageAt: null };
const enabled = ['conversations', 'chatTransport', 'chatState'] as const;
const ready = new BriefCapabilities(enabled.map(id => ({ id, provider: { readiness: () => 'ready' } })), enabled).snapshot();

class FakeSocket {
  static OPEN = 1; static CONNECTING = 0; static CLOSED = 3;
  readyState = 0; binaryType = ''; sent: Array<{ type: string; payload: any; id: string }> = [];
  onopen: (() => void) | null = null; onclose: (() => void) | null = null; onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor(readonly url: string) { sockets.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
  close() { this.readyState = 3; this.onclose?.(); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  receive(type: string, payload: unknown, id?: string) { this.onmessage?.({ data: JSON.stringify({ type, payload, id, timestamp: 10 }) }); }
}
beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost:4389/' });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  React = await import('react'); ({ createRoot } = await import('react-dom/client'));
  ({ BriefConversationProvider: Provider, useBriefConversation: useChat } = await import('./provider'));
});
beforeEach(() => {
  originalFetch = globalThis.fetch; OriginalWebSocket = globalThis.WebSocket;
  sockets.length = 0; requests.length = 0;
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  globalThis.fetch = (async (input: string) => {
    requests.push(input);
    return Response.json(input.includes('/active?channel=websocket') ? { messages: [{ id: 'legacy', role: 'user', content: 'Legacy history', created_at: 1 }] } : []);
  }) as unknown as typeof fetch;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await React.act(async () => root.unmount()); host.remove();
  globalThis.fetch = originalFetch; globalThis.WebSocket = OriginalWebSocket;
});
afterAll(() => GlobalRegistrator.unregister());
function clientFixture() {
  const api: ConversationApi = {
    capabilities: async () => ready,
    tabs: async () => ({ workspaceId: 'workspace', activeConversationId: 'chat-a', revision: '1', tabs: [tab] }),
    create: async () => { throw new Error('Not used'); }, tab: async () => { throw new Error('Not used'); },
    select: async () => { throw new Error('Not used'); }, history: async () => ({ items: [], nextCursor: null }),
  };
  return { api, client: new BriefConversationClient(api) };
}
function Room({ name, theme }: { name: string; theme: string }) {
  observed = useChat();
  return <div data-room={name} data-theme={theme}>{observed.messages.map(message => message.content).join('|')}</div>;
}
async function render(client: BriefConversationClient, room = 'today', theme = 'light', enabled = true, chatVisible = false) {
  await React.act(async () => root.render(<React.StrictMode><Provider client={client} enabled={enabled} chatVisible={chatVisible}><Room key={room} name={room} theme={theme} /></Provider></React.StrictMode>));
}
async function open(socket: FakeSocket) { await React.act(async () => { socket.open(); await Promise.resolve(); }); }

test('one connection survives ten room/theme remounts and retains the provider-owned draft', async () => {
  const { client } = clientFixture(); await render(client);
  expect(sockets).toHaveLength(1); await open(sockets[0]!);
  await React.act(async () => client.store.setDraft('chat-a', 'Survives navigation'));
  for (let i = 0; i < 10; i++) await render(client, `room-${i}`, i % 2 ? 'dark' : 'light');
  expect(sockets).toHaveLength(1); expect(sockets[0]?.readyState).toBe(1);
  expect(observed.current?.draft).toBe('Survives navigation');
  expect(requests.filter(path => path.includes('active?channel'))).toEqual([]);
  expect(sockets[0]?.sent.filter(frame => frame.type === 'brief_chat_subscribe')).toHaveLength(1);
  await React.act(async () => window.dispatchEvent(new Event('jarvis:ws-reconnect')));
  expect(sockets).toHaveLength(1);
});

test('old backend uses the existing single-chat history and writer without a scoped frame', async () => {
  const { client, api } = clientFixture(); api.capabilities = async () => ({});
  await render(client); expect(sockets).toHaveLength(1); await open(sockets[0]!);
  expect(observed.status.mode).toBe('legacy'); expect(host.textContent).toContain('Legacy history');
  await React.act(async () => { observed.send('Hello old daemon'); });
  expect(sockets[0]?.sent.at(-1)).toMatchObject({ type: 'chat', payload: { text: 'Hello old daemon' } });
  expect(sockets[0]?.sent.some(frame => frame.type.startsWith('brief_chat_'))).toBe(false);
});

test('disconnect/retry and capability loss close scoped ownership before opening a fresh legacy socket', async () => {
  const { client, api } = clientFixture(); await render(client); const scoped = sockets[0]!; await open(scoped);
  const lateHandler = scoped.onmessage;
  await React.act(async () => { scoped.close(); });
  api.capabilities = async () => ({});
  await React.act(async () => window.dispatchEvent(new Event('jarvis:ws-reconnect')));
  expect(sockets).toHaveLength(2);
  await open(sockets[1]!);
  expect(observed.status.mode).toBe('legacy');
  expect(sockets[1]?.readyState).toBe(3); expect(sockets).toHaveLength(3);
  await open(sockets[2]!);
  expect(sockets.filter(socket => socket.readyState === 1)).toHaveLength(1);
  expect(lateHandler).not.toBeNull();
  expect(scoped.onmessage).toBeNull();
  expect(host.textContent).toContain('Legacy history');
});

test('disabled provider opens no connection, and unmount cannot schedule a reconnect', async () => {
  const { client } = clientFixture(); await render(client, 'today', 'light', false);
  expect(sockets).toHaveLength(0);
  await render(client); const socket = sockets[0]!; await open(socket);
  await React.act(async () => root.render(<div>Unmounted</div>));
  socket.close(); window.dispatchEvent(new Event('jarvis:ws-reconnect'));
  expect(socket.onclose).toBeNull(); expect(sockets).toHaveLength(1);
  expect(client.getSnapshot().mode).toBe('disabled');
});

test('browser visibility and panel visibility jointly determine whether the active chat is read', async () => {
  const { client } = clientFixture();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  try {
    await render(client, 'today', 'light', true, true);
    await React.act(async () => client.store.applyEvent({ conversationId: 'chat-a', turnId: 't', requestId: 'r', eventId: 'e', sequence: 1,
      payload: { kind: 'delta', messageId: 'answer', text: 'While hidden' } }, 10));
    expect(observed.current?.unread).toEqual(['answer']);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await React.act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(observed.current?.unread).toEqual([]);
    await render(client, 'today', 'light', true, false);
    await React.act(async () => client.store.applyEvent({ conversationId: 'chat-a', turnId: 't2', requestId: 'r2', eventId: 'e2', sequence: 2,
      payload: { kind: 'delta', messageId: 'answer-2', text: 'Panel hidden' } }, 11));
    expect(observed.current?.unread).toEqual(['answer-2']);
    expect(sockets).toHaveLength(1);
  } finally { Reflect.deleteProperty(document, 'visibilityState'); }
});

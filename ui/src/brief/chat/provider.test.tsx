import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { BriefCapabilities } from '../../../../src/brief/capabilities';
import { BriefConversationClient } from './client';
import type { ConversationApi } from './api';
import type { BriefConversation } from '../../../../src/brief/contracts';
import { BriefReconciliationClient } from '../reconciliation/client';
import { useBriefProjection } from '../reconciliation/react';

let useSocket: typeof import('../../hooks/useWebSocket').useWebSocket;
let socketState: ReturnType<typeof useSocket>;
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
  ({ useWebSocket: useSocket } = await import('../../hooks/useWebSocket'));
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
test('reconciliation observes scoped approvals on the shared socket without remounting draft, selection or scroll', async () => {
  const { client } = clientFixture();
  const caps = new BriefCapabilities([{ id: 'reconciliation', provider: { readiness: () => 'ready' } }], ['reconciliation']).snapshot();
  const reconciliation = new BriefReconciliationClient({ capabilities: async () => caps });
  let data = ['original'], reads = 0, mounts = 0;
  const projection = reconciliation.projection({ domains: ['decisions'], read: async () => {
    reads++; return { data, empty: false, asOf: Date.now() };
  } });
  function StableRoom() {
    const value = useBriefProjection(projection);
    const [selected] = React.useState('selected-run');
    React.useEffect(() => { mounts++; }, []);
    return <div data-testid="scroll" style={{ height: 100, overflow: 'auto' }}><input aria-label="Draft" defaultValue="Keep this draft" />
      <p>{selected}</p><p>{value.state}: {value.data?.join(',')}</p></div>;
  }
  await React.act(async () => root.render(<Provider client={client} reconciliation={reconciliation} enabled><StableRoom /></Provider>));
  await open(sockets[0]!);
  const input = host.querySelector('input')!, scroll = host.querySelector('div')!;
  input.focus(); input.setSelectionRange(2, 7); scroll.scrollTop = 91;
  data = ['original', 'pending-approval'];
  const frame = { conversationId: 'chat-a', turnId: 't', requestId: 'r', eventId: 'approval-event', sequence: 1,
    payload: { kind: 'approval', approvalId: 'pending-approval', status: 'pending' } };
  const before = reads;
  await React.act(async () => { sockets[0]!.receive('brief_chat_event', frame); sockets[0]!.receive('brief_chat_event', frame); });
  expect(reads).toBe(before + 1); expect(host.textContent).toContain('pending-approval');
  expect(host.querySelector('input')).toBe(input); expect(document.activeElement).toBe(input);
  expect(input.value).toBe('Keep this draft'); expect(input.selectionStart).toBe(2); expect(scroll.scrollTop).toBe(91);
  expect(host.textContent).toContain('selected-run'); expect(mounts).toBe(1); expect(sockets).toHaveLength(1);
  data = ['after-reconnect'];
  await React.act(async () => { sockets[0]!.close(); window.dispatchEvent(new Event('jarvis:ws-reconnect')); });
  await open(sockets[1]!); expect(host.textContent).toContain('after-reconnect');
  expect(mounts).toBe(1); expect(input.value).toBe('Keep this draft'); expect(scroll.scrollTop).toBe(91);
  data = ['after-focus']; await React.act(async () => { window.dispatchEvent(new Event('focus')); });
  expect(host.textContent).toContain('after-focus'); expect(sockets).toHaveLength(2);
});

test('replacing the optional observer keeps the legacy socket and an observer exception cannot consume chat', async () => {
  const { client, api } = clientFixture(); api.capabilities = async () => ({});
  const first = new BriefReconciliationClient({ capabilities: async () => ({}) });
  const second = new BriefReconciliationClient({ capabilities: async () => ({}) });
  const show = async (reconciliation: BriefReconciliationClient) => React.act(async () => root.render(
    <Provider client={client} reconciliation={reconciliation} enabled><Room name="today" theme="light" /></Provider>));
  await show(first); await open(sockets[0]!); await show(second);
  second.observer.onMessage = () => { throw Error('Optional observer failed'); };
  await React.act(async () => { observed.send('Still works'); });
  expect(sockets).toHaveLength(1); expect(host.textContent).toContain('Legacy history');
  expect(sockets[0]?.sent.at(-1)).toMatchObject({ type: 'chat', payload: { text: 'Still works' } });
  await React.act(async () => sockets[0]!.receive('notification', { source: 'approval_request', request: {
    id: 'approval', agent_name: 'Fixture', tool_name: 'fixture', action_category: 'write_data', urgency: 'normal', reason: 'Approval needed',
  } }));
  await React.act(async () => sockets[0]!.receive('notification', { source: 'assistant_message', text: 'Delivered despite observer failure' }));
  expect(host.textContent).toContain('Delivered despite observer failure');
  // The observer's failure leaves normal routing live (no reconnection or chat ownership change).
  expect(observed.status.mode).toBe('legacy'); expect(sockets[0]?.readyState).toBe(1);
});
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

test('an accepted failed response exposes its explanation and never projects partial output as done', async () => {
  const { client } = clientFixture(); await render(client); const socket = sockets[0]!; await open(socket);
  const ref = { conversationId: 'chat-a', turnId: 'failed-turn', requestId: 'failed-request' };
  await React.act(async () => {
    socket.receive('brief_chat_event', { ...ref, eventId: 'partial', sequence: 1, payload: { kind: 'delta', messageId: 'answer', text: 'Partial response' } });
    socket.receive('brief_chat_event', { ...ref, eventId: 'failure', sequence: 2, payload: { kind: 'terminal', state: 'failed', error: { code: 'generation_failed', message: 'Please try again.' } } });
  });
  expect(observed.current?.error).toBe('Please try again.');
  expect(observed.items.find(item => item.id === 'answer')).toMatchObject({ text: 'Partial response', status: 'failed' });
  expect(observed.isResponding).toBe(false);
});

function ConnectionProbe({ chat }: { chat?: import('../../hooks/useWebSocket').WebSocketChatAdapter }) {
  socketState = useSocket({ chat });
  return null;
}

for (const change of ['disconnect', 'mode change', 'unmount'] as const) {
  test(`queued room actions expire on ${change} and obsolete callbacks cannot affect the next connection`, async () => {
    const adapter = { onOpen: () => {}, onClose: () => {}, onMessage: () => false };
    await React.act(async () => root.render(<ConnectionProbe chat={adapter} />));
    const first = sockets[0]!; await open(first);
    const oldClose = first.onclose!;
    const oldMessage = first.onmessage!;
    const action = (id: string) => ({ source: 'room_action', room: 'tasks', action: 'create_task',
      args: { title: id }, resultId: id, resultFrom: 'dashboard' });
    await React.act(async () => first.receive('notification', action('old-action')));
    const oldAction = socketState.roomActionRequest!;
    expect(oldAction.resultId).toBe('old-action');
    expect(oldAction.stillAsked?.()).toBe(true);

    if (change === 'disconnect') {
      await React.act(async () => first.close());
    } else if (change === 'mode change') {
      await React.act(async () => root.render(<ConnectionProbe />));
    } else {
      await React.act(async () => root.render(<div>Unmounted</div>));
    }
    expect(oldAction.stillAsked?.()).toBe(false);
    expect(first.onclose).toBeNull();
    expect(first.onmessage).toBeNull();
    if (change === 'unmount') {
      await React.act(async () => { oldClose(); window.dispatchEvent(new Event('jarvis:ws-reconnect')); });
      expect(sockets).toHaveLength(1);
      return;
    }
    if (change === 'disconnect') {
      await React.act(async () => window.dispatchEvent(new Event('jarvis:ws-reconnect')));
    }
    expect(sockets).toHaveLength(2);
    const current = sockets[1]!; await open(current);
    await React.act(async () => current.receive('notification', action('current-action')));
    const currentAction = socketState.roomActionRequest!;
    expect(currentAction.resultId).toBe('current-action');
    expect(currentAction.stillAsked?.()).toBe(true);
    await React.act(async () => {
      oldClose();
      oldMessage({ data: JSON.stringify({ type: 'notification', payload: action('late-action'), timestamp: 20 }) });
    });
    expect(socketState.roomActionRequest).toBe(currentAction);
    expect(currentAction.stillAsked?.()).toBe(true);
    expect(oldAction.stillAsked?.()).toBe(false);
    expect(socketState.isConnected).toBe(true);
    expect(sockets.filter(socket => socket.readyState === 1)).toHaveLength(1);
  });
}

// #1075: mounting the provider in place of the dashboard hook must hide none of
// its outputs. Only the chat fields are re-derived for a scoped conversation.
const REDERIVED = ['messages', 'isConnected', 'sendMessage', 'cancelResponse', 'isResponding'];
test('the provider passes through every dashboard socket output it does not re-derive', async () => {
  await React.act(async () => root.render(<ConnectionProbe />));
  const socketKeys = Object.keys(socketState).filter(key => !REDERIVED.includes(key));
  // Not vacuous: the fields the issue names are among them.
  expect(socketKeys).toEqual(expect.arrayContaining(['approvals', 'clarifiers', 'repeatBacks', 'roomActionRequest']));
  await React.act(async () => root.render(<div />));
  const { client } = clientFixture(); await render(client);
  for (const key of socketKeys) expect(observed).toHaveProperty(key);
});

test('a scoped conversation still shows approvals, clarifiers, repeat-backs and room actions live, without a re-fetch', async () => {
  const { client } = clientFixture(); await render(client); const socket = sockets[0]!; await open(socket);
  expect(observed.status.mode).toBe('scoped');
  const fetched = requests.filter(path => path.startsWith('/api/authority/approvals')).length;
  // The one re-fetch is the socket open's; the count below would see another.
  expect(fetched).toBe(1);
  const request = { id: 'brief-approval-1', agent_name: 'PA', tool_name: 'run_command', action_category: 'execute_command',
    urgency: 'normal', reason: 'execute_command requires user approval' };
  await React.act(async () => {
    socket.receive('brief_chat_event', { conversationId: 'chat-a', turnId: 't', requestId: 'r', eventId: 'e', sequence: 1,
      payload: { kind: 'approval', approvalId: request.id, status: 'pending' } });
    socket.receive('notification', { source: 'approval_request', request, shortId: 'brief-ap', impact: 'write', intent: 'Run make deploy' });
    socket.receive('notification', { source: 'clarifier_request', id: 'clarify-1', transcript: 'open the thing', intent: { verb: 'show', object: { query: 'thing' } } });
    socket.receive('notification', { source: 'repeat_back_request', id: 'repeat-1', transcript: 'delete the draft' });
    socket.receive('notification', { source: 'room_action', room: 'tasks', action: 'create_task', args: { title: 'x' }, resultId: 'act-1', resultFrom: 'dashboard' });
  });
  expect(observed.approvals.map(approval => approval.id)).toEqual([request.id]);
  expect(observed.clarifiers.map(clarifier => clarifier.id)).toEqual(['clarify-1']);
  expect(observed.repeatBacks.map(repeat => repeat.id)).toEqual(['repeat-1']);
  expect(observed.roomActionRequest?.resultId).toBe('act-1');
  // The card settles live too, and nothing went back to the REST list for it
  // (a regression guard: no client code re-fetches on a Brief approval event).
  await React.act(async () => socket.receive('notification', { source: 'approval_update', request: { ...request, status: 'approved' } }));
  expect(observed.approvals).toEqual([]);
  expect(requests.filter(path => path.startsWith('/api/authority/approvals')).length).toBe(fetched);
});

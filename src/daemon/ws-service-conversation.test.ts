import { expect, test } from 'bun:test';
import { WebSocketService } from './ws-service.ts';
import type { AgentService } from './agent-service.ts';
import type { WSMessage } from '../comms/websocket.ts';
import type { ApprovalRequest } from '../authority/approval.ts';
import type { SidecarManager } from '../sidecar/manager.ts';
import { PanelSessionStore } from '../sidecar/panel-sessions.ts';
import { initDatabase, closeDb, getDb } from '../vault/schema.ts';
import { BriefConversationProvider } from '../brief/conversations.ts';
import { BriefChatTransport } from '../brief/chat-transport.ts';
import { registerChatTransport } from '../brief/registrations/chat-transport.ts';
import { registerConversations } from '../brief/registrations/conversations.ts';
import { createBriefCapabilities } from '../brief/registrations/index.ts';
import type { BriefChatEvent } from '../brief/contracts.ts';
import type { LLMStreamEvent } from '../llm/provider.ts';

const done = (): LLMStreamEvent => ({ type: 'done', response: { content: 'Answer', tool_calls: [], usage: { input_tokens: 0, output_tokens: 0 }, model: 'fixture', finish_reason: 'stop' } });
async function until(check: () => boolean) { const end = Date.now() + 2000; while (!check()) { if (Date.now() > end) throw new Error('WebSocket fixture timed out'); await Bun.sleep(1); } }

test('authenticated WebSocket routing gates the feature, scopes approvals and preserves legacy mirroring', async () => {
  initDatabase(':memory:', { quiet: true });
  const config = { onboarding: { setup_completed_at: new Date().toISOString() } };
  const fakeAgent = { setDelegationCallback: () => {}, getConfig: () => config,
    streamMessage: () => ({ stream: (async function* () { yield { type: 'text', text: 'Legacy reply' } as LLMStreamEvent; yield done(); })(), onComplete: async () => {} }),
  } as unknown as AgentService;
  const service = new WebSocketService(0, fakeAgent);
  const sessions = new PanelSessionStore(); const session = sessions.create('fixture-device');
  const manager = { resolvePanelSession: (id: string) => sessions.get(id), openPanelSession: async () => null,
    panelSocketOpened: () => {}, panelSocketClosed: () => {} } as unknown as SidecarManager;
  service.getServer().setSidecarManager(manager);
  const conversations = new BriefConversationProvider();
  let generations = 0;
  const approval = { id: 'stable-approval', status: 'pending' } as ApprovalRequest;
  const transport = new BriefChatTransport({ db: getDb(), runner: { ready: () => true, stream: () => {
    generations++;
    return { onComplete: async () => {}, stream: (async function* () {
      service.broadcastSubAgentProgress({ type: 'tool_call', agentName: 'Private name', agentId: 'agent-a', data: { secret: 'hidden-tool-arguments' } });
      service.broadcastTaskEvent({ type: 'task_started', task_id: 'task-a', template: 'write', intent: 'Private task intent', status: 'running', elapsedMs: 0 });
      service.broadcastApprovalRequest(approval);
      yield { type: 'text', text: 'Scoped reply' } as LLMStreamEvent; yield done();
    })() };
  } }, send: (client, message) => service.getServer().sendToClient(client, message) });
  const registrations = [...registerConversations(conversations), ...registerChatTransport(transport)];
  service.setBriefChatTransport(transport, createBriefCapabilities(registrations, ['conversations']));
  const clients: WebSocket[] = [];
  try {
    await service.start();
    const port = (service.getServer() as unknown as { server: { port: number } }).server.port;
    expect((await fetch(`http://localhost:${port}/ws`)).status).toBe(401);
    const connect = async () => {
      const frames: WSMessage[] = [];
      const socket = new WebSocket(`ws://localhost:${port}/ws`, { headers: { Cookie: `panel_session=${session.id}` } } as any);
      clients.push(socket);
      socket.onmessage = event => frames.push(JSON.parse(String(event.data)) as WSMessage);
      await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = () => reject(new Error('Connection failed')); });
      return { socket, frames, send: (type: WSMessage['type'], payload: unknown) => socket.send(JSON.stringify({ type, payload, timestamp: Date.now() })) };
    };
    const scoped = await connect(), legacy = await connect(), mirror = await connect();
    const a = conversations.repository.create({ title: 'A' });
    const b = conversations.repository.create({ title: 'B' });
    const send = { conversationId: a.conversationId, turnId: 'turn-a', requestId: 'request-a', text: 'Hello' };
    scoped.send('brief_chat_send', send);
    await until(() => scoped.frames.some(frame => frame.type === 'brief_chat_error'));
    expect(generations).toBe(0); expect(conversations.repository.messages(a.conversationId).items).toEqual([]);
    service.setBriefChatTransport(transport, createBriefCapabilities(registrations, ['conversations', 'chatTransport']));
    scoped.send('brief_chat_send', send);
    await until(() => scoped.frames.some(frame => frame.type === 'brief_chat_event' && (frame.payload as BriefChatEvent).payload.kind === 'terminal'));
    const events = scoped.frames.filter(frame => frame.type === 'brief_chat_event').map(frame => frame.payload as BriefChatEvent);
    expect(events.every(event => event.conversationId === a.conversationId && event.turnId === 'turn-a' && event.requestId === 'request-a')).toBe(true);
    expect(events.filter(event => event.payload.kind === 'activity')).toHaveLength(2);
    expect(events.find(event => event.payload.kind === 'approval')?.payload).toEqual({ kind: 'approval', approvalId: 'stable-approval', status: 'pending' });
    expect(legacy.frames.some(frame => frame.type === 'brief_chat_event')).toBe(false);
    expect(mirror.frames.some(frame => frame.type === 'brief_chat_event')).toBe(false);
    expect(JSON.stringify(scoped.frames)).not.toContain('hidden-tool-arguments');
    expect(JSON.stringify(scoped.frames)).not.toContain('Private task intent');
    // Changing the saved active tab does not reassign the approval's origin.
    conversations.repository.activate(b.conversationId);
    service.broadcastApprovalUpdate({ ...approval, status: 'approved' });
    await until(() => scoped.frames.some(frame => frame.type === 'brief_chat_event' && (frame.payload as any).payload.status === 'approved'));
    expect((scoped.frames.at(-1)!.payload as BriefChatEvent).conversationId).toBe(a.conversationId);
    expect(transport.repository.approvalOwner(approval.id)?.turnId).toBe('turn-a');
    // Legacy readers still receive the existing stream/status wire shape.
    const scopedCount = scoped.frames.length;
    service.broadcastSubAgentProgress({ type: 'tool_call', agentName: 'Legacy agent', agentId: 'legacy', data: { secret: 'legacy-private' } });
    service.broadcastTaskEvent({ type: 'task_started', task_id: 'legacy', template: 'write', intent: 'legacy-private', status: 'running', elapsedMs: 0 });
    legacy.send('chat', { text: 'Hi', skipIntercept: true });
    await until(() => [legacy, mirror].every(reader => reader.frames.some(frame => frame.type === 'status' && (frame.payload as any).status === 'done')));
    // Delivery on one socket does not imply the other sockets have drained.
    service.getServer().broadcast({ type: 'status', id: 'fixture-barrier', payload: { status: 'fixture_barrier' }, timestamp: Date.now() });
    await until(() => [scoped, legacy, mirror].every(reader => reader.frames.some(frame => frame.id === 'fixture-barrier')));
    expect(legacy.frames.some(frame => frame.type === 'stream' && (frame.payload as any).text === 'Legacy reply')).toBe(true);
    expect(mirror.frames.some(frame => frame.type === 'stream' && (frame.payload as any).text === 'Legacy reply')).toBe(true);
    expect(scoped.frames.slice(scopedCount).some(frame => frame.type === 'stream' || frame.type === 'thinking_end' || frame.type === 'task_event')).toBe(false);
    expect(JSON.stringify(scoped.frames)).not.toContain('legacy-private');
    expect(generations).toBe(1);
  } finally {
    for (const client of clients) client.close();
    await service.stop(); await transport.idle(); closeDb();
  }
});

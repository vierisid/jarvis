import { expect, test } from 'bun:test';
import { WebSocketService } from './ws-service.ts';
import type { AgentService } from './agent-service.ts';
import type { WSMessage } from '../comms/websocket.ts';
import type { SidecarManager } from '../sidecar/manager.ts';
import { PanelSessionStore } from '../sidecar/panel-sessions.ts';
import { initDatabase, closeDb, getDb } from '../vault/schema.ts';
import { BriefConversationProvider } from '../brief/conversations.ts';
import { BriefChatTransport } from '../brief/chat-transport.ts';
import { registerChatTransport } from '../brief/registrations/chat-transport.ts';
import { registerConversations } from '../brief/registrations/conversations.ts';
import { createBriefCapabilities } from '../brief/registrations/index.ts';
import type { LLMStreamEvent } from '../llm/provider.ts';
import { AI_PROVIDER_NEEDED_CODE, AI_PROVIDER_NEEDED_MESSAGE } from '../brief/ai-provider-needed.ts';

const done = (): LLMStreamEvent => ({ type: 'done', response: { content: 'Answer', tool_calls: [], usage: { input_tokens: 0, output_tokens: 0 }, model: 'fixture', finish_reason: 'stop' } });
async function until(check: () => boolean) { const end = Date.now() + 2000; while (!check()) { if (Date.now() > end) throw new Error('WebSocket fixture timed out'); await Bun.sleep(1); } }

/** A person who skipped the AI step finishes setup with no provider saved. Chat
 * must say so plainly instead of failing mid-turn, and must still answer once a
 * provider exists. */
async function sendOnce(options: { setupDone: boolean; providers: string[] }) {
  initDatabase(':memory:', { quiet: true });
  const config = { onboarding: options.setupDone ? { setup_completed_at: Date.now() } : {} };
  const fakeAgent = { setDelegationCallback: () => {}, getConfig: () => config,
    getLLMManager: () => ({ getProviderNames: () => options.providers }) } as unknown as AgentService;
  const service = new WebSocketService(0, fakeAgent);
  const sessions = new PanelSessionStore(); const session = sessions.create('fixture-device');
  service.getServer().setSidecarManager({ resolvePanelSession: (id: string) => sessions.get(id), openPanelSession: async () => null,
    panelSocketOpened: () => {}, panelSocketClosed: () => {} } as unknown as SidecarManager);
  const conversations = new BriefConversationProvider();
  let generations = 0;
  const transport = new BriefChatTransport({ db: getDb(), runner: { ready: () => true, stream: () => {
    generations++;
    return { onComplete: async () => {}, stream: (async function* () { yield { type: 'text', text: 'Hi' } as LLMStreamEvent; yield done(); })() };
  } }, send: (client, message) => service.getServer().sendToClient(client, message) });
  const registrations = [...registerConversations(conversations), ...registerChatTransport(transport)];
  service.setBriefChatTransport(transport, createBriefCapabilities(registrations, ['conversations', 'chatTransport']));
  let socket: WebSocket | undefined;
  try {
    await service.start();
    const port = (service.getServer() as unknown as { server: { port: number } }).server.port;
    const frames: WSMessage[] = [];
    socket = new WebSocket(`ws://localhost:${port}/ws`, { headers: { Cookie: `panel_session=${session.id}` } } as any);
    socket.onmessage = event => frames.push(JSON.parse(String(event.data)) as WSMessage);
    await new Promise<void>((resolve, reject) => { socket!.onopen = () => resolve(); socket!.onerror = () => reject(new Error('Connection failed')); });
    const chat = conversations.repository.create({ title: 'A' });
    socket.send(JSON.stringify({ type: 'brief_chat_send', timestamp: Date.now(),
      payload: { conversationId: chat.conversationId, turnId: 'turn-a', requestId: 'request-a', text: 'Hello' } }));
    await until(() => frames.some(f => f.type === 'brief_chat_error' || f.type === 'brief_chat_event'));
    return { frames, generations: () => generations };
  } finally { socket?.close(); await service.stop(); closeDb(); }
}

test('chat with no AI provider saved says an AI provider is needed and never starts a turn', async () => {
  const r = await sendOnce({ setupDone: true, providers: [] });
  const error = r.frames.find(f => f.type === 'brief_chat_error')!;
  expect(error.payload).toMatchObject({ code: AI_PROVIDER_NEEDED_CODE, message: AI_PROVIDER_NEEDED_MESSAGE });
  expect(r.generations()).toBe(0);
});

test('chat before setup is finished says to finish setup, not that a provider is missing', async () => {
  const r = await sendOnce({ setupDone: false, providers: [] });
  expect(r.frames.find(f => f.type === 'brief_chat_error')!.payload).toMatchObject({ code: 'setup_required' });
  expect(r.generations()).toBe(0);
});

test('chat with an AI provider saved runs the turn as before', async () => {
  const r = await sendOnce({ setupDone: true, providers: ['anthropic'] });
  expect(r.frames.some(f => f.type === 'brief_chat_error')).toBe(false);
  expect(r.generations()).toBe(1);
});

/** The classic chat and voice paths share the gate: with setup saved and no
 * provider, neither reaches the agent (which would persist the turn and fail
 * on the model call). */
function directService(providers: string[]) {
  let agentCalls = 0;
  const config = { onboarding: { setup_completed_at: Date.now() } };
  const fakeAgent = new Proxy({ setDelegationCallback: () => {}, getConfig: () => config, getLLMManager: () => ({ getProviderNames: () => providers }) } as Record<string, unknown>, {
    get: (target, prop) => prop in target ? target[prop as string] : (..._args: unknown[]) => { agentCalls++; throw new Error(`agent.${String(prop)} reached`); },
  }) as unknown as AgentService;
  const service = new WebSocketService(0, fakeAgent);
  const acks: string[] = [];
  (service as unknown as { broadcastAssistantAck: (text: string) => void }).broadcastAssistantAck = text => { acks.push(text); };
  return { service: service as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>, acks, agentCalls: () => agentCalls };
}

test('classic chat with no AI provider saved is refused with the AI provider message before reaching the agent', async () => {
  const d = directService([]);
  const reply = await d.service.handleChatTurn!({ type: 'chat', payload: { text: 'Hello' }, id: 'chat-a', timestamp: Date.now() }) as WSMessage;
  expect(reply.type).toBe('error');
  expect((reply.payload as { message: string }).message).toBe(AI_PROVIDER_NEEDED_MESSAGE);
  expect(d.agentCalls()).toBe(0);
});

test('a spoken request with no AI provider saved gets the AI provider message, and window control still works', async () => {
  const d = directService([]);
  await d.service.processVoiceTranscriptTurn!('what is on my calendar', 'voice-a', { send: () => {} } as never);
  expect(d.acks).toEqual([AI_PROVIDER_NEEDED_MESSAGE]);
  await d.service.processVoiceTranscriptTurn!('close', 'voice-b', { send: () => {} } as never);
  expect(d.acks.length).toBe(2);
  expect(d.acks[1]).not.toBe(AI_PROVIDER_NEEDED_MESSAGE);
  expect(d.agentCalls()).toBe(0);
});

test('the interview with no AI provider saved says a provider is needed and how to move on, not to finish setup', async () => {
  const d = directService([]);
  const sent: WSMessage[] = [];
  (d.service as unknown as { wsServer: { sendToClient: (ws: unknown, m: WSMessage) => void } }).wsServer.sendToClient = (_ws, m) => { sent.push(m); };
  await d.service.handleInterviewMessage!({} as never, null);
  const message = String((sent.find(m => m.type === 'interview_error')!.payload as { message: string }).message);
  expect(message).toContain('AI provider');
  expect(message).toContain('Skip');
  expect(message).not.toContain('Finish setup');
});

import { beforeEach, expect, test } from 'bun:test';
import { WebSocketService } from './ws-service.ts';
import { getDb, initDatabase } from '../vault/schema.ts';
import type { WSMessage } from '../comms/websocket.ts';
import type { LLMStreamEvent } from '../llm/provider.ts';

/**
 * Q-19, review C5: a turn that completed and was shown, whose reply then could
 * not be saved, is not a failed request. It must not read "Nothing was done",
 * and its task must not be marked failed.
 */
let sent: WSMessage[];
let svc: WebSocketService;

beforeEach(() => {
  initDatabase(':memory:', { quiet: true });
  sent = [];
  const fakeAgent = {
    setDelegationCallback: () => {},
    getConfig: () => ({ onboarding: { setup_completed_at: 1 } }),
    streamMessage: () => ({
      stream: (async function* (): AsyncGenerator<LLMStreamEvent> {
        yield { type: 'text', text: 'Done: the file is saved.' };
        yield { type: 'done', response: { content: 'Done: the file is saved.', tool_calls: [], usage: { input_tokens: 1, output_tokens: 1 }, model: 'test', finish_reason: 'stop' } };
      })(),
      onComplete: async () => {},
    }),
  };
  svc = new WebSocketService(0, fakeAgent as never);
  const server = (svc as unknown as { wsServer: Record<string, unknown> }).wsServer;
  server.broadcast = (m: WSMessage) => { sent.push(m); };
  server.broadcastWithReceipt = (m: WSMessage) => { sent.push(m); return 1; };
});

test('a reply that could not be saved after the turn completed is reported as that, not as a failed request', async () => {
  getDb().run(`CREATE TRIGGER no_saved_replies BEFORE INSERT ON conversation_messages WHEN NEW.role = 'assistant'
    BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END`);
  const reply = await (svc as unknown as { handleChat: (msg: WSMessage) => Promise<WSMessage | void> })
    .handleChat({ type: 'chat', id: 'req-1', payload: { text: 'save the file please', skipIntercept: true }, timestamp: Date.now() });
  expect(reply).toBeUndefined();
  expect(sent.filter(m => m.type === 'error')).toEqual([]);
  const notice = sent.find(m => m.type === 'chat' && String((m.payload as { text?: unknown }).text).startsWith('Saving this reply'));
  expect((notice?.payload as { text: string }).text).toStartWith('Saving this reply to the conversation failed. Nothing was done.');
  expect((notice?.payload as { text: string }).text).toContain('database or disk is full');
  expect(sent.some(m => m.type === 'status' && (m.payload as { status?: string }).status === 'done')).toBe(true);
});

test('a tool call may act unless Authority judges it purely as reading; an unknown tool may act', () => {
  const tools: Record<string, { category: string }> = { read_file: { category: 'file-ops' }, write_file: { category: 'file-ops' } };
  (svc as unknown as { agentService: unknown }).agentService = {
    getOrchestrator: () => ({ getToolRegistry: () => ({ get: (name: string) => tools[name] }) }),
  };
  const mayAct = (name: string) => (svc as unknown as { toolMayAct: (n: string, a: Record<string, unknown>) => boolean }).toolMayAct(name, {});
  expect(mayAct('read_file')).toBe(false);
  expect(mayAct('write_file')).toBe(true);
  expect(mayAct('no_such_tool')).toBe(true);
});

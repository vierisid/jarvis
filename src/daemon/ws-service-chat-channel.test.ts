import { beforeEach, expect, test } from 'bun:test';
import { WebSocketService } from './ws-service.ts';
import { getDb, initDatabase } from '../vault/schema.ts';
import type { WSMessage } from '../comms/websocket.ts';
import type { LLMStreamEvent } from '../llm/provider.ts';

/**
 * #1157: a dashboard chat frame named its own channel. A socket that claimed
 * "telegram" or "pebble" had its turn written to that channel's conversation,
 * read that channel's most recent history (from any sender) and got that
 * channel's prompt. A dashboard turn is always the websocket channel.
 */
let channels: string[];
let svc: WebSocketService;
beforeEach(() => {
  initDatabase(':memory:', { quiet: true });
  channels = [];
  const fakeAgent = {
    setDelegationCallback: () => {},
    getConfig: () => ({ onboarding: { setup_completed_at: 1 } }),
    streamMessage: (_text: string, channel: string) => {
      channels.push(channel);
      return { stream: (async function* (): AsyncGenerator<LLMStreamEvent> {
        yield { type: 'text', text: 'ok' };
        yield { type: 'done', response: { content: 'ok', tool_calls: [], usage: { input_tokens: 1, output_tokens: 1 }, model: 'test', finish_reason: 'stop' } };
      })(), onComplete: async () => {} };
    },
  };
  svc = new WebSocketService(0, fakeAgent as never);
  const server = (svc as unknown as { wsServer: Record<string, unknown> }).wsServer;
  server.broadcast = () => {};
  server.broadcastWithReceipt = () => 1;
});

test('a chat frame cannot choose the channel its turn is recorded and answered under', async () => {
  const chat = (svc as unknown as { handleChat: (msg: WSMessage) => Promise<WSMessage | void> }).handleChat.bind(svc);
  for (const claimed of ['telegram', 'pebble', 'discord', undefined]) {
    await chat({ type: 'chat', id: `req-${claimed}`, payload: { text: 'hello there', skipIntercept: true, ...(claimed ? { channel: claimed } : {}) }, timestamp: Date.now() });
  }
  expect(channels).toEqual(['websocket', 'websocket', 'websocket', 'websocket']);
  const stored = getDb().query('SELECT DISTINCT channel FROM conversations').all() as Array<{ channel: string }>;
  expect(stored.map(r => r.channel)).toEqual(['websocket']);
});

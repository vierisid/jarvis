/**
 * Nothing is spoken back while the notch is on, and everything speaks as it
 * did while it is off. One test per place that could speak.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { BriefChatTransport } from '../brief/chat-transport.ts';
import type { TTSProvider } from '../comms/voice.ts';
import type { JarvisConfig } from '../config/types.ts';
import { realtimeEnablement } from '../daemon/usejarvis-ai.ts';
import { WebSocketService } from '../daemon/ws-service.ts';
import { getOrCreateConversation } from '../vault/conversations.ts';
import { closeDb, getDb, initDatabase } from '../vault/schema.ts';
import { notchSilent } from './silence.ts';
import { NOTCH_SWITCH } from './switch.ts';

let before: string | undefined;
beforeEach(() => { before = process.env[NOTCH_SWITCH]; });
afterEach(() => {
  if (before === undefined) delete process.env[NOTCH_SWITCH]; else process.env[NOTCH_SWITCH] = before;
  try { closeDb(); } catch { /* not opened */ }
});
const notch = (on: boolean): void => { if (on) process.env[NOTCH_SWITCH] = '1'; else delete process.env[NOTCH_SWITCH]; };

/** A voice that counts what it is asked to say. */
function voice() {
  const said: string[] = [];
  const tts = {
    synthesize: async (text: string) => { said.push(text); return Buffer.from('audio'); },
    async *synthesizeStream(text: string) { said.push(text); yield Buffer.from('audio'); },
  } as unknown as TTSProvider;
  return { tts, said };
}

describe('the rule', () => {
  test('is the notch switch, exactly', () => {
    expect(notchSilent({})).toBe(false);
    expect(notchSilent({ [NOTCH_SWITCH]: 'true' })).toBe(false);
    expect(notchSilent({ [NOTCH_SWITCH]: '1' })).toBe(true);
  });
});

describe('live voice', () => {
  const config = { voice: { realtime: { enabled: true } } } as unknown as JarvisConfig;
  test('is off with the notch on, whatever the settings say, and as set with it off', () => {
    notch(false);
    expect(realtimeEnablement(config, () => null)).toBe('user-on');
    notch(true);
    expect(realtimeEnablement(config, () => null)).toBe('off');
  });
});

describe('a dashboard message sent with "speak"', () => {
  async function send(allowed: boolean): Promise<{ said: string[]; state: string; reply: string | undefined }> {
    initDatabase(':memory:', { quiet: true });
    const v = voice();
    const transport = new BriefChatTransport({
      db: getDb(), send: () => {}, tts: () => v.tts, speakAllowed: () => allowed,
      runner: { ready: () => true, stream: () => ({
        stream: (async function* () {
          yield { type: 'text' as const, text: 'Four.' };
          yield { type: 'done' as const, response: { content: 'Four.', tool_calls: [], usage: { input_tokens: 0, output_tokens: 0 }, model: 'x', finish_reason: 'stop' as const } };
        })(),
        onComplete: async () => {},
      }) },
    });
    const conversationId = getOrCreateConversation('websocket').id;
    const ref = { conversationId, turnId: 't1', requestId: 'r1' };
    // As the socket handler does it: a spoken turn has a client that owns its audio.
    const internals = transport as unknown as { schedule(turn: unknown, client: unknown, progress: boolean): void; clients: Map<unknown, Set<string>> };
    const client = {};
    internals.clients.set(client, new Set([conversationId]));
    const accepted = transport.repository.accept({ ...ref, text: 'two plus two', speak: true, attachmentIds: [] });
    internals.schedule(accepted.turn, client, true);
    await transport.idle();
    const stored = getDb().query<{ content: string }, [string]>('SELECT content FROM conversation_messages WHERE id = ?').get(accepted.turn.assistantMessageId);
    return { said: v.said, state: transport.repository.get(ref).state, reply: stored?.content };
  }

  test('is spoken while speaking is allowed', async () => {
    expect(await send(true)).toEqual({ said: ['Four.'], state: 'completed', reply: 'Four.' });
  });

  test('is accepted and answered in text, and not spoken, with the notch on', async () => {
    expect(await send(false)).toEqual({ said: [], state: 'completed', reply: 'Four.' });
  });
});

describe('a suggestion, a workflow voice note, the tutorial', () => {
  function service() {
    initDatabase(':memory:', { quiet: true });
    const svc = new WebSocketService(0, { setDelegationCallback: () => {}, getConfig: () => ({ onboarding: { setup_completed_at: 1 } }) } as never);
    const v = voice();
    svc.setTTSProvider(v.tts);
    const sent: unknown[] = [];
    const server = (svc as unknown as { wsServer: {
      broadcast(m: unknown): void; sendToClient(ws: unknown, m: unknown): void; getClientCount(): number; getClients(): unknown[];
      sendBinaryToClient?: (ws: unknown, b: unknown) => void;
    } }).wsServer;
    const client = { send: () => 1 };
    server.broadcast = (m) => { sent.push(m); };
    server.sendToClient = (_ws, m) => { sent.push(m); };
    server.sendBinaryToClient = () => {};
    server.getClientCount = () => 1;
    server.getClients = () => [client];
    return { svc, said: v.said, sent };
  }

  test('are not spoken with the notch on, and report that nobody heard them', async () => {
    notch(true);
    const s = service();
    expect(await s.svc.broadcastProactiveVoice('You have a meeting in five minutes.')).toBe(0);
    expect(s.said).toEqual([]);
    expect(s.sent).toEqual([]);
  });

  test('are spoken as before with the notch off', async () => {
    notch(false);
    const s = service();
    await s.svc.broadcastProactiveVoice('You have a meeting in five minutes.').catch(() => 0);
    expect(s.said).toEqual(['You have a meeting in five minutes.']);
  });
});

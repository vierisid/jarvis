import { beforeEach, describe, expect, test } from 'bun:test';
import { WebSocketService } from './ws-service.ts';
import { initDatabase } from '../vault/schema.ts';
import type { JarvisConfig } from '../config/types.ts';
import type { InterviewSession } from './onboarding-interviewer.ts';

/** Exercise the actual WS message boundary without binding a port. */
const makeService = (llmManager?: unknown) => {
  const fakeAgent = {
    setDelegationCallback: () => {},
    getConfig: () => ({ llm: { providers: {} } }) as unknown as JarvisConfig,
    getLLMManager: () => llmManager ?? { getProviderNames: () => [] as string[] },
  } as never;
  const svc = new WebSocketService(0, fakeAgent);
  const makeClient = () => {
    const sent: Array<Record<string, unknown>> = [];
    const binary: unknown[] = [];
    const ws = {
      send: (raw: string) => { sent.push(JSON.parse(raw) as Record<string, unknown>); },
      sendBinary: (chunk: unknown) => { binary.push(chunk); },
    } as never;
    (svc as unknown as { wsServer: { getClients: () => Set<unknown> } }).wsServer.getClients().add(ws);
    return { ws, sent, binary };
  };
  const internals = svc as unknown as {
    routeMessage: (msg: unknown, ws: unknown) => Promise<unknown>;
    interviewSessions: Map<unknown, InterviewSession>;
    interviewPendingText: Map<unknown, string>;
    interviewTurnsInFlight: Set<unknown>;
    voiceSessions: Map<unknown, unknown>;
    endInterviewSession: (ws: unknown) => void;
  };
  return { svc, internals, makeClient };
};

const makeBridge = () => {
  const calls: string[] = [];
  return {
    calls,
    bridge: {
      arm: async () => { calls.push('arm'); return { armed: true }; },
      disarm: () => { calls.push('disarm'); },
      setActive: (active: boolean) => { calls.push(`setActive:${active}`); },
    },
  };
};

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const send = async (
  internals: ReturnType<typeof makeService>['internals'],
  ws: unknown,
  type: string,
  payload: Record<string, unknown> = {},
) => {
  await internals.routeMessage({ type, payload, timestamp: Date.now() }, ws);
  await tick();
};
const lastOfType = (sent: Array<Record<string, unknown>>, type: string) =>
  [...sent].reverse().find(m => m.type === type);

const makeLLM = (done = false) => ({
  getProviderNames: () => ['stub'],
  hasConversationTier: () => false,
  chatTier: async () => ({
    content: done ? 'You can ask for a workflow draft after setup.' : 'What are you building?',
    tool_calls: done
      ? [{ id: 'wrap', name: 'wrap_interview', arguments: { farewell: 'Thanks for the context.' } }]
      : [],
  }),
});

describe('written interview transport', () => {
  beforeEach(() => initDatabase(':memory:'));

  test('opening and replying never activate the microphone or synthesize audio, even for legacy speakReply requests', async () => {
    const { svc, internals, makeClient } = makeService(makeLLM());
    const { calls, bridge } = makeBridge();
    svc.setInterviewVoiceBridge(bridge);
    let synthesisCalls = 0;
    svc.setTTSProvider({
      synthesizeStream: async function* () {
        synthesisCalls++;
        yield Buffer.from('unexpected interview audio');
      },
    } as never);
    const { ws, sent, binary } = makeClient();

    await send(internals, ws, 'interview_start', { speakReply: true });
    await send(internals, ws, 'interview_user_message', { text: 'I am building a studio.', speakReply: true });

    expect(svc.hasActiveInterview()).toBe(true);
    expect(calls).toEqual([]);
    expect(synthesisCalls).toBe(0);
    expect(binary).toEqual([]);
    const replies = sent.filter(m => m.type === 'interview_assistant');
    expect(replies).toHaveLength(2);
    expect(replies.every(m => (m.payload as { will_speak: boolean }).will_speak === false)).toBe(true);
    expect(sent.some(m => m.type === 'tts_start' || m.type === 'tts_end')).toBe(false);
    expect(internals.interviewSessions.get(ws)?.messages.some(m => m.role === 'user' && m.content === 'I am building a studio.')).toBe(true);
  });

  test('legacy microphone requests receive text-only without touching ordinary voice capture', async () => {
    const { svc, internals, makeClient } = makeService();
    const { calls, bridge } = makeBridge();
    svc.setInterviewVoiceBridge(bridge);
    const { ws, sent } = makeClient();
    await send(internals, ws, 'interview_start');
    await send(internals, ws, 'voice_start', { requestId: 'normal-voice', mode: 'wav' });
    const normalCapture = internals.voiceSessions.get(ws);
    expect(normalCapture).toBeDefined();

    await send(internals, ws, 'interview_listen', { speakReply: true });
    await send(internals, ws, 'interview_listen_stop');

    expect(lastOfType(sent, 'interview_listen_state')?.payload).toEqual({ armed: false, reason: 'text-only' });
    expect(calls).toEqual([]);
    expect(internals.voiceSessions.get(ws)).toBe(normalCapture);
  });

  test('a stale client receives text-only even without a running interview or bridge', async () => {
    const { internals, makeClient } = makeService();
    const { ws, sent } = makeClient();
    await send(internals, ws, 'interview_listen');
    expect(lastOfType(sent, 'interview_listen_state')?.payload).toEqual({ armed: false, reason: 'text-only' });
    expect(internals.interviewSessions.size).toBe(0);
  });

  test('Pebble speech is never consumed as an interview answer, including with multiple windows', async () => {
    const { svc, internals, makeClient } = makeService(makeLLM());
    const first = makeClient();
    const second = makeClient();
    expect(svc.deliverInterviewVoice('Before setup')).toBe(false);
    await send(internals, first.ws, 'interview_start');
    await send(internals, second.ws, 'interview_start');
    const histories = [...internals.interviewSessions.values()].map(session => [...session.messages]);

    expect(svc.deliverInterviewVoice('I design products in Milan')).toBe(false);
    expect(svc.deliverInterviewVoice('   ')).toBe(false);
    svc.notifyInterviewListenEnded('no-speech');
    await tick();

    expect([...internals.interviewSessions.values()].map(session => session.messages)).toEqual(histories);
    expect([...first.sent, ...second.sent].some(m => m.type === 'interview_user_transcript' || m.type === 'interview_listen_state')).toBe(false);
  });

  test('wrapping sends written completion and clears the session without changing normal voice', async () => {
    const { svc, internals, makeClient } = makeService(makeLLM(true));
    const { calls, bridge } = makeBridge();
    svc.setInterviewVoiceBridge(bridge);
    const { ws, sent } = makeClient();
    await send(internals, ws, 'interview_start', { speakReply: true });

    expect(lastOfType(sent, 'interview_done')).toBeDefined();
    expect(svc.hasActiveInterview()).toBe(false);
    expect(internals.interviewTurnsInFlight.size).toBe(0);
    expect(internals.interviewPendingText.size).toBe(0);
    expect(calls).toEqual([]);
  });
});

/** Hold each model call so overlapping typed input and disconnects are testable. */
const makeSlowLLM = () => {
  const seen: Array<Array<{ role: string; content: string }>> = [];
  let release: (() => void) | null = null;
  return {
    seen,
    finishTurn: async () => {
      const go = release;
      release = null;
      go?.();
      await tick();
    },
    llm: {
      getProviderNames: () => ['stub'],
      hasConversationTier: () => false,
      chatTier: async (_tier: string, _caller: string, messages: Array<{ role: string; content: string }>) => {
        seen.push(messages.map(m => ({ role: m.role, content: m.content })));
        await new Promise<void>(resolve => { release = resolve; });
        return { content: 'What work do you repeat?', tool_calls: [] };
      },
    },
  };
};

describe('written interview turn lifecycle', () => {
  test('typed replies arriving mid-turn run next in order, while speech stays outside the interview', async () => {
    const slow = makeSlowLLM();
    const { svc, internals, makeClient } = makeService(slow.llm);
    const { ws, sent } = makeClient();
    await send(internals, ws, 'interview_start');
    await send(internals, ws, 'interview_user_message', { text: "I'm a designer" });
    await send(internals, ws, 'interview_user_message', { text: 'in Milan' });
    expect(svc.deliverInterviewVoice('Unrelated voice conversation')).toBe(false);
    expect(slow.seen).toHaveLength(1);

    await slow.finishTurn();
    expect(slow.seen).toHaveLength(2);
    const nextTurn = slow.seen[1]!;
    expect(nextTurn.filter(m => m.role === 'user').at(-1)?.content).toBe("I'm a designer in Milan");
    expect(nextTurn.some(m => m.content === 'Unrelated voice conversation')).toBe(false);
    const roles = nextTurn.map(m => m.role).filter(role => role === 'user' || role === 'assistant');
    expect(roles.some((role, index) => index > 0 && role === roles[index - 1])).toBe(false);
    await slow.finishTurn();
    expect(sent.filter(m => m.type === 'interview_assistant')).toHaveLength(2);
  });

  test('disconnect drops queued input and ignores the late reply', async () => {
    const slow = makeSlowLLM();
    const { svc, internals, makeClient } = makeService(slow.llm);
    const { calls, bridge } = makeBridge();
    svc.setInterviewVoiceBridge(bridge);
    const { ws, sent } = makeClient();
    await send(internals, ws, 'interview_start');
    await send(internals, ws, 'interview_user_message', { text: 'A queued answer' });

    // The disconnect handler sweeps the session map before its lifecycle cleanup.
    internals.interviewSessions.delete(ws);
    internals.endInterviewSession(ws);
    await slow.finishTurn();

    expect(slow.seen).toHaveLength(1);
    expect(sent.some(m => m.type === 'interview_assistant')).toBe(false);
    expect(internals.interviewTurnsInFlight.size).toBe(0);
    expect(internals.interviewPendingText.size).toBe(0);
    expect(svc.hasActiveInterview()).toBe(false);
    expect(calls).toEqual([]);
  });
});

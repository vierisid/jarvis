import { beforeEach, describe, expect, test } from 'bun:test';
import { WebSocketService } from './ws-service.ts';
import { initDatabase } from '../vault/schema.ts';
import { getUserProfile } from '../vault/user-profile.ts';
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
const hasRepeatedRole = (messages: Array<{ role: string }>) => {
  const roles = messages.map(m => m.role).filter(role => role === 'user' || role === 'assistant');
  return roles.some((role, index) => index > 0 && role === roles[index - 1]);
};

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

  test('opening and replying never synthesize audio, even for legacy speakReply requests', async () => {
    const { svc, internals, makeClient } = makeService(makeLLM());
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

    expect(internals.interviewSessions.has(ws)).toBe(true);
    expect(synthesisCalls).toBe(0);
    expect(binary).toEqual([]);
    const replies = sent.filter(m => m.type === 'interview_assistant');
    expect(replies).toHaveLength(2);
    expect(replies.every(m => (m.payload as { will_speak: boolean }).will_speak === false)).toBe(true);
    expect(sent.some(m => m.type === 'tts_start' || m.type === 'tts_end')).toBe(false);
    expect(internals.interviewSessions.get(ws)?.messages.some(m => m.role === 'user' && m.content === 'I am building a studio.')).toBe(true);
  });

  test('legacy microphone requests receive text-only without touching ordinary voice capture', async () => {
    const { internals, makeClient } = makeService();
    const { ws, sent } = makeClient();
    await send(internals, ws, 'interview_start');
    await send(internals, ws, 'voice_start', { requestId: 'normal-voice', mode: 'wav' });
    const normalCapture = internals.voiceSessions.get(ws);
    expect(normalCapture).toBeDefined();

    await send(internals, ws, 'interview_listen', { speakReply: true });
    await send(internals, ws, 'interview_listen_stop');

    expect(lastOfType(sent, 'interview_listen_state')?.payload).toEqual({ armed: false, reason: 'text-only' });
    expect(internals.voiceSessions.get(ws)).toBe(normalCapture);
  });

  test('a stale client receives text-only even without a running interview', async () => {
    const { internals, makeClient } = makeService();
    const { ws, sent } = makeClient();
    await send(internals, ws, 'interview_listen');
    expect(lastOfType(sent, 'interview_listen_state')?.payload).toEqual({ armed: false, reason: 'text-only' });
    expect(internals.interviewSessions.size).toBe(0);
  });

  test('wrapping sends written completion and clears the session', async () => {
    const { internals, makeClient } = makeService(makeLLM(true));
    const { ws, sent } = makeClient();
    await send(internals, ws, 'interview_start', { speakReply: true });

    expect(lastOfType(sent, 'interview_done')).toBeDefined();
    expect(internals.interviewSessions.size).toBe(0);
    expect(internals.interviewTurnsInFlight.size).toBe(0);
    expect(internals.interviewPendingText.size).toBe(0);
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
  test('typed replies arriving mid-turn run next in order', async () => {
    const slow = makeSlowLLM();
    const { internals, makeClient } = makeService(slow.llm);
    const { ws, sent } = makeClient();
    await send(internals, ws, 'interview_start');
    await send(internals, ws, 'interview_user_message', { text: "I'm a designer" });
    await send(internals, ws, 'interview_user_message', { text: 'in Milan' });
    expect(slow.seen).toHaveLength(1);

    await slow.finishTurn();
    expect(slow.seen).toHaveLength(2);
    const nextTurn = slow.seen[1]!;
    expect(nextTurn.filter(m => m.role === 'user').at(-1)?.content).toBe("I'm a designer in Milan");
    expect(hasRepeatedRole(nextTurn)).toBe(false);
    await slow.finishTurn();
    expect(sent.filter(m => m.type === 'interview_assistant')).toHaveLength(2);
  });

  test('disconnect drops queued input and ignores the late reply', async () => {
    const slow = makeSlowLLM();
    const { internals, makeClient } = makeService(slow.llm);
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
    expect(internals.interviewSessions.size).toBe(0);
  });

  test('a failed turn is rolled back so a retried answer is not a second user turn', async () => {
    const seen: Array<Array<{ role: string; content: string }>> = [];
    let calls = 0;
    const llm = {
      getProviderNames: () => ['stub'],
      hasConversationTier: () => false,
      chatTier: async (_tier: string, _caller: string, messages: Array<{ role: string; content: string }>) => {
        seen.push(messages.map(m => ({ role: m.role, content: m.content })));
        if (++calls === 2) throw new Error('provider overloaded');
        return { content: 'What work do you repeat?', tool_calls: [] };
      },
    };
    const { internals, makeClient } = makeService(llm);
    const { ws, sent } = makeClient();
    await send(internals, ws, 'interview_start');
    const session = internals.interviewSessions.get(ws)!;
    const historyBefore = [...session.messages];
    const turnsBefore = session.turnCount;

    await send(internals, ws, 'interview_user_message', { text: 'I run a studio' });
    expect(lastOfType(sent, 'interview_error')).toBeDefined();
    expect(session.messages).toEqual(historyBefore);
    expect(session.turnCount).toBe(turnsBefore);

    await send(internals, ws, 'interview_user_message', { text: 'I run a studio' });
    expect(seen).toHaveLength(3);
    expect(hasRepeatedRole(seen[2]!)).toBe(false);
    expect(seen[2]!.filter(m => m.content === 'I run a studio')).toHaveLength(1);
    expect(sent.filter(m => m.type === 'interview_assistant')).toHaveLength(2);
  });

  test('facts from a turn that fails after recording them are not saved, so a retry does not duplicate them', async () => {
    initDatabase(':memory:');
    const recordFact = (summary: string) => ({
      content: '',
      tool_calls: [{ id: `fact-${summary}`, name: 'record_profile_facts', arguments: { facts: [{ theme: 'work', summary }] } }],
    });
    const replies: Array<() => unknown> = [
      () => ({ content: 'What are you building?', tool_calls: [] }),
      () => recordFact('Runs a design studio'),
      () => { throw new Error('provider overloaded'); },
      () => recordFact('Runs a small design studio'),
      () => ({ content: 'What repeats each week?', tool_calls: [] }),
    ];
    const llm = {
      getProviderNames: () => ['stub'],
      hasConversationTier: () => false,
      chatTier: async () => replies.shift()!(),
    };
    const { internals, makeClient } = makeService(llm);
    const { ws, sent } = makeClient();
    await send(internals, ws, 'interview_start');
    const session = internals.interviewSessions.get(ws)!;

    await send(internals, ws, 'interview_user_message', { text: 'I run a design studio' });
    expect(lastOfType(sent, 'interview_error')).toBeDefined();
    expect(session.factsRecorded).toBe(0);
    expect(getUserProfile()?.interview_facts ?? []).toHaveLength(0);

    await send(internals, ws, 'interview_user_message', { text: 'I run a design studio' });
    expect(session.factsRecorded).toBe(1);
    expect((getUserProfile()?.interview_facts ?? []).map(f => f.summary)).toEqual(['Runs a small design studio']);
    expect((lastOfType(sent, 'interview_assistant')?.payload as { facts_recorded: number }).facts_recorded).toBe(1);
  });
});

import { describe, expect, test } from 'bun:test';
import { WebSocketService } from './ws-service.ts';
import type { JarvisConfig } from '../config/types.ts';

/**
 * The onboarding interview owns the user's voice while it runs.
 *
 * Before this, speech during the first interview was captured by the pebble
 * and answered by the assistant — the interview only ever heard what was
 * typed into its composer. These tests pin the hand-off: the interview claims
 * the mic when it starts, a transcript captured off-socket is delivered to
 * the interviewer, and the mic goes back to the assistant when it ends.
 *
 * The second suite pins the other half of that hand-off: because speech can
 * now arrive at any moment, turns have to be serialized — the interviewer
 * mutates one message history across awaits.
 *
 * The service is constructed but never start()ed (no port bound);
 * routeMessage and the public bridge entry points are exercised directly.
 * Where the LLM is irrelevant the stub reports no providers, so each turn
 * stops at `interview_error` instead of calling a model — the session
 * lifecycle under test is identical either way.
 */

const makeService = (llmManager?: unknown) => {
  const fakeAgent = {
    setDelegationCallback: () => {},
    getConfig: () => ({ llm: { providers: {} } }) as unknown as JarvisConfig,
    getLLMManager: () => llmManager ?? { getProviderNames: () => [] as string[] },
  } as never;
  const svc = new WebSocketService(0, fakeAgent);
  const makeClient = () => {
    const sent: Array<Record<string, unknown>> = [];
    const ws = {
      send: (raw: string) => { sent.push(JSON.parse(raw) as Record<string, unknown>); },
      sendBinary: () => {},
    } as never;
    (svc as unknown as { wsServer: { getClients: () => Set<unknown> } }).wsServer.getClients().add(ws);
    return { ws, sent };
  };
  const internals = svc as unknown as {
    routeMessage: (msg: unknown, ws: unknown) => Promise<unknown>;
    interviewSessions: Map<unknown, unknown>;
  };
  return { svc, internals, makeClient };
};

/** Records what the daemon's pebble bridge was asked to do. */
const makeBridge = (arm: { armed: boolean; reason?: string } = { armed: true }) => {
  const calls: string[] = [];
  return {
    calls,
    bridge: {
      arm: async () => { calls.push('arm'); return arm; },
      disarm: () => { calls.push('disarm'); },
      setActive: (active: boolean) => { calls.push(`setActive:${active}`); },
    },
  };
};

const startInterview = async (
  internals: ReturnType<typeof makeService>['internals'],
  ws: unknown,
) => {
  await internals.routeMessage({ type: 'interview_start', payload: {}, timestamp: Date.now() }, ws);
  // The handler is fire-and-forget; let it run.
  await new Promise<void>(r => setTimeout(r, 0));
};

const lastOfType = (sent: Array<Record<string, unknown>>, type: string) =>
  [...sent].reverse().find(m => m.type === type);

describe('interview voice hand-off', () => {
  test('starting an interview takes the microphone off the assistant', async () => {
    const { svc, internals, makeClient } = makeService();
    const { calls, bridge } = makeBridge();
    svc.setInterviewVoiceBridge(bridge);
    const { ws } = makeClient();

    expect(svc.hasActiveInterview()).toBe(false);
    await startInterview(internals, ws);

    expect(svc.hasActiveInterview()).toBe(true);
    expect(calls).toContain('setActive:true');
  });

  test('a pebble transcript is delivered to the interview, not the assistant', async () => {
    const { svc, internals, makeClient } = makeService();
    const { bridge } = makeBridge();
    svc.setInterviewVoiceBridge(bridge);
    const { ws, sent } = makeClient();
    await startInterview(internals, ws);

    expect(svc.deliverInterviewVoice('  I design products in Milan  ')).toBe(true);
    const echoed = lastOfType(sent, 'interview_user_transcript');
    expect(echoed).toBeDefined();
    expect((echoed!.payload as { text: string }).text).toBe('I design products in Milan');
  });

  test('with no interview running the transcript is refused so the assistant answers', () => {
    const { svc } = makeService();
    svc.setInterviewVoiceBridge(makeBridge().bridge);
    expect(svc.deliverInterviewVoice('what is the weather')).toBe(false);
  });

  test('a blank transcript is refused rather than sent as a turn', async () => {
    const { svc, internals, makeClient } = makeService();
    svc.setInterviewVoiceBridge(makeBridge().bridge);
    const { ws, sent } = makeClient();
    await startInterview(internals, ws);

    expect(svc.deliverInterviewVoice('   ')).toBe(false);
    expect(lastOfType(sent, 'interview_user_transcript')).toBeUndefined();
  });

  test('interview_listen arms the pebble and tells the UI it worked', async () => {
    const { svc, internals, makeClient } = makeService();
    const { calls, bridge } = makeBridge();
    svc.setInterviewVoiceBridge(bridge);
    const { ws, sent } = makeClient();
    await startInterview(internals, ws);

    await internals.routeMessage({ type: 'interview_listen', payload: {}, timestamp: Date.now() }, ws);
    await new Promise<void>(r => setTimeout(r, 0));

    expect(calls).toContain('arm');
    expect(lastOfType(sent, 'interview_listen_state')?.payload).toEqual({ armed: true });
  });

  test('a refused mic is reported with its reason so the UI can fall back', async () => {
    const { svc, internals, makeClient } = makeService();
    const { bridge } = makeBridge({ armed: false, reason: 'muted' });
    svc.setInterviewVoiceBridge(bridge);
    const { ws, sent } = makeClient();
    await startInterview(internals, ws);

    await internals.routeMessage({ type: 'interview_listen', payload: {}, timestamp: Date.now() }, ws);
    await new Promise<void>(r => setTimeout(r, 0));

    expect(lastOfType(sent, 'interview_listen_state')?.payload).toEqual({ armed: false, reason: 'muted' });
  });

  test('with no bridge wired the UI is told at once instead of waiting on a mic', async () => {
    const { svc, internals, makeClient } = makeService();
    const { ws, sent } = makeClient();
    await startInterview(internals, ws);

    await internals.routeMessage({ type: 'interview_listen', payload: {}, timestamp: Date.now() }, ws);
    await new Promise<void>(r => setTimeout(r, 0));

    expect(lastOfType(sent, 'interview_listen_state')?.payload).toEqual({ armed: false, reason: 'no-pebble' });
  });

  test('interview_listen_stop hands the microphone back', async () => {
    const { svc, internals, makeClient } = makeService();
    const { calls, bridge } = makeBridge();
    svc.setInterviewVoiceBridge(bridge);
    const { ws } = makeClient();
    await startInterview(internals, ws);
    await internals.routeMessage({ type: 'interview_listen', payload: {}, timestamp: Date.now() }, ws);
    await new Promise<void>(r => setTimeout(r, 0));

    await internals.routeMessage({ type: 'interview_listen_stop', payload: {}, timestamp: Date.now() }, ws);
    expect(calls).toContain('disarm');
  });

  test('an abandoned interview releases the mic — the assistant is not left mute', async () => {
    const { svc, internals, makeClient } = makeService();
    const { calls, bridge } = makeBridge();
    svc.setInterviewVoiceBridge(bridge);
    const { ws } = makeClient();
    await startInterview(internals, ws);
    await internals.routeMessage({ type: 'interview_listen', payload: {}, timestamp: Date.now() }, ws);
    await new Promise<void>(r => setTimeout(r, 0));

    // What the WS server's onDisconnect does: sweep the maps, then release.
    internals.interviewSessions.delete(ws);
    (svc as unknown as { endInterviewVoice: (ws: unknown) => void }).endInterviewVoice(ws);

    expect(calls).toContain('disarm');
    expect(calls).toContain('setActive:false');
    expect(svc.hasActiveInterview()).toBe(false);
  });

  test('an empty capture is reported so the interview can re-arm', async () => {
    const { svc, internals, makeClient } = makeService();
    svc.setInterviewVoiceBridge(makeBridge().bridge);
    const { ws, sent } = makeClient();
    await startInterview(internals, ws);

    svc.notifyInterviewListenEnded('no-speech');
    expect(lastOfType(sent, 'interview_listen_state')?.payload).toEqual({ armed: false, reason: 'no-speech' });
  });

  test('the newest interview window owns the mic', async () => {
    const { svc, internals, makeClient } = makeService();
    svc.setInterviewVoiceBridge(makeBridge().bridge);
    const first = makeClient();
    const second = makeClient();
    await startInterview(internals, first.ws);
    await startInterview(internals, second.ws);

    expect(svc.deliverInterviewVoice('hello')).toBe(true);
    expect(lastOfType(second.sent, 'interview_user_transcript')).toBeDefined();
    expect(lastOfType(first.sent, 'interview_user_transcript')).toBeUndefined();
  });
});

/**
 * A stub LLM whose turns finish only when the test says so. Records the
 * message history each turn was handed, which is what the serialization
 * claim is really about.
 */
const makeSlowLLM = () => {
  const seen: Array<Array<{ role: string; content: string }>> = [];
  let release: (() => void) | null = null;
  return {
    seen,
    /** Let the turn that is currently blocked finish. */
    finishTurn: async () => {
      const go = release;
      release = null;
      go?.();
      await new Promise<void>(r => setTimeout(r, 0));
    },
    llm: {
      getProviderNames: () => ['stub'],
      hasConversationTier: () => false,
      chatTier: async (
        _tier: string,
        _caller: string,
        messages: Array<{ role: string; content: string }>,
      ) => {
        seen.push(messages.map(m => ({ role: m.role, content: m.content })));
        await new Promise<void>(r => { release = r; });
        return { content: 'And what do you do?', tool_calls: [] };
      },
    },
  };
};

describe('interview turns are serialized', () => {
  test('speech arriving mid-turn runs next instead of interleaving', async () => {
    const slow = makeSlowLLM();
    const { svc, internals, makeClient } = makeService(slow.llm);
    svc.setInterviewVoiceBridge(makeBridge().bridge);
    const { ws, sent } = makeClient();

    // Opening turn — blocked inside the LLM call.
    void internals.routeMessage({ type: 'interview_start', payload: {}, timestamp: Date.now() }, ws);
    await new Promise<void>(r => setTimeout(r, 0));
    expect(slow.seen.length).toBe(1);

    // Two utterances land while that turn is still running.
    expect(svc.deliverInterviewVoice("I'm a designer")).toBe(true);
    expect(svc.deliverInterviewVoice('in Milan')).toBe(true);
    // Still one turn in flight: neither raced into the shared history.
    expect(slow.seen.length).toBe(1);

    await slow.finishTurn();      // opening turn completes → queued text runs
    expect(slow.seen.length).toBe(2);
    const second = slow.seen[1]!;
    // Both utterances arrived as ONE user turn, in order.
    expect(second.filter(m => m.role === 'user').at(-1)!.content).toBe("I'm a designer in Milan");
    // …and the history is still strictly alternating, never user-after-user.
    const roles = second.map(m => m.role).filter(r => r === 'user' || r === 'assistant');
    expect(roles.some((r, i) => i > 0 && r === roles[i - 1])).toBe(false);

    await slow.finishTurn();
    expect(sent.filter(m => m.type === 'interview_assistant').length).toBe(2);
  });

  test('a mid-turn transcript is never handed back to the assistant', async () => {
    const slow = makeSlowLLM();
    const { svc, internals, makeClient } = makeService(slow.llm);
    svc.setInterviewVoiceBridge(makeBridge().bridge);
    const { ws } = makeClient();
    void internals.routeMessage({ type: 'interview_start', payload: {}, timestamp: Date.now() }, ws);
    await new Promise<void>(r => setTimeout(r, 0));

    // `true` is what tells the daemon "handled — do not run a response
    // cycle". Returning false here would put the answer to an interview
    // question through the assistant, which is the bug this all fixes.
    expect(svc.deliverInterviewVoice('mid-turn answer')).toBe(true);

    await slow.finishTurn();
    await slow.finishTurn();
  });
});

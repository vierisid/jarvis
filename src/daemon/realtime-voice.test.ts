import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { RealtimeVoiceSession } from './realtime-voice.ts';
import type { RealtimeSession, RealtimeFunctionCall, RealtimeTranscript, RealtimeUsage } from '../comms/realtime.ts';
import { BrowserAudioTransport } from '../comms/audio-transport.ts';
import type { ResolvedRealtimeVoice } from '../config/realtime.ts';
import { initDatabase, closeDb, getDb } from '../vault/schema.ts';
import { setUsageDatabase } from '../llm/usage.ts';

const RESOLVED: ResolvedRealtimeVoice = {
  apiKey: 'k', provider: 'usejarvis_ai', url: 'wss://proxy.test/v1/realtime', model: 'gpt-realtime-2', reasoningEffort: 'low', maxSessionMinutes: 10, blockedCategories: [],
};

/** Fake RealtimeSession capturing wired callbacks + outgoing results. */
class FakeRealtimeSession {
  fnCb: ((c: RealtimeFunctionCall) => void) | null = null;
  transcriptCb: ((t: RealtimeTranscript) => void) | null = null;
  usageCb: ((u: RealtimeUsage) => void) | null = null;
  errorCb: ((e: string) => void) | null = null;
  closeCb: (() => void) | null = null;
  results: Array<{ callId: string; result: unknown }> = [];
  connected = false;
  closed = false;
  onAudio() {}
  onTranscript(cb: (t: RealtimeTranscript) => void) { this.transcriptCb = cb; }
  onFunctionCall(cb: (c: RealtimeFunctionCall) => void) { this.fnCb = cb; }
  onUsage(cb: (u: RealtimeUsage) => void) { this.usageCb = cb; }
  onError(cb: (e: string) => void) { this.errorCb = cb; }
  onOpen() {}
  onClose(cb: () => void) { this.closeCb = cb; }
  onSpeechStarted() {}
  async connect() { this.connected = true; }
  sendFunctionResult(callId: string, result: unknown) { this.results.push({ callId, result }); }
  interrupt() {}
  close() { this.closed = true; }
}

function setup(executeToolCall: (n: string, a: Record<string, unknown>) => Promise<string>) {
  const fake = new FakeRealtimeSession();
  const transport = new BrowserAudioTransport({ sendAudio: () => {}, inputSampleRate: 24000 });
  const transcripts: RealtimeTranscript[] = [];
  let closeCalls = 0;
  const rv = new RealtimeVoiceSession(RESOLVED, transport, {
    tools: [],
    instructions: 'persona',
    executeToolCall,
    onTranscript: (t) => transcripts.push(t),
    onClose: () => { closeCalls++; },
    sessionFactory: () => fake as unknown as RealtimeSession,
  });
  return { fake, rv, transcripts, getCloseCalls: () => closeCalls };
}

describe('RealtimeVoiceSession', () => {
  test('connect() delegates to the underlying session', async () => {
    const { fake, rv } = setup(async () => 'ok');
    await rv.connect();
    expect(fake.connected).toBe(true);
  });

  test('function call runs executeToolCall and returns the result to the model', async () => {
    const calls: Array<{ name: string; args: unknown }> = [];
    const { fake, rv } = setup(async (name, args) => { calls.push({ name, args }); return 'FILE CONTENTS'; });
    await rv.connect();
    await fake.fnCb!({ callId: 'c1', name: 'read_file', args: { path: '/x' } });
    // allow the async handler microtask to settle
    await Promise.resolve();
    expect(calls).toEqual([{ name: 'read_file', args: { path: '/x' } }]);
    expect(fake.results).toEqual([{ callId: 'c1', result: 'FILE CONTENTS' }]);
  });

  test('executor errors are returned as a result string, never thrown', async () => {
    const { fake, rv } = setup(async () => { throw new Error('boom'); });
    await rv.connect();
    await fake.fnCb!({ callId: 'c2', name: 'bad', args: {} });
    await Promise.resolve();
    expect(fake.results).toHaveLength(1);
    expect(String(fake.results[0]!.result)).toContain('boom');
  });

  test('transcripts are forwarded', async () => {
    const { fake, rv, transcripts } = setup(async () => 'ok');
    await rv.connect();
    fake.transcriptCb!({ role: 'assistant', text: 'hi', final: true });
    expect(transcripts).toEqual([{ role: 'assistant', text: 'hi', final: true }]);
  });

  test('underlying close propagates to onClose', async () => {
    const { fake, rv, getCloseCalls } = setup(async () => 'ok');
    await rv.connect();
    fake.closeCb!();
    expect(getCloseCalls()).toBe(1);
  });

  test('close() tears down the session and suppresses late results', async () => {
    const { fake, rv } = setup(async () => 'late');
    await rv.connect();
    rv.close();
    expect(fake.closed).toBe(true);
    await fake.fnCb!({ callId: 'c3', name: 'read_file', args: {} });
    await Promise.resolve();
    expect(fake.results).toHaveLength(0); // not sent after close
  });
});

describe('RealtimeVoiceSession usage tracking', () => {
  beforeEach(() => {
    closeDb();
    initDatabase(':memory:');
    setUsageDatabase(() => getDb());
  });
  afterEach(() => {
    closeDb();
    // Reset the global resolver - without this, every other test file that
    // calls chatTier/streamTier without first initDatabase would see this
    // file's `() => getDb()` resolver and trip its throw. recordUsage itself
    // is now defensive (catches resolver throws), but resetting here keeps
    // process state clean and matches the documented best-effort contract.
    setUsageDatabase(() => null);
  });

  test('usage events land in llm_usage as conversation/realtime_voice', async () => {
    const { fake, rv } = setup(async () => 'ok');
    await rv.connect();
    fake.usageCb!({ input_tokens: 100, output_tokens: 25, latency_ms: 420 });

    const rows = getDb()!
      .query<{ tier: string; subsystem: string; provider: string; model: string; input_tokens: number; output_tokens: number; latency_ms: number }, []>(
        'SELECT tier, subsystem, provider, model, input_tokens, output_tokens, latency_ms FROM llm_usage',
      )
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      tier: 'conversation',
      subsystem: 'realtime_voice',
      provider: 'usejarvis_ai',
      model: 'gpt-realtime-2',
      input_tokens: 100,
      output_tokens: 25,
      latency_ms: 420,
    });
  });
});

describe('RealtimeVoiceSession error copy', () => {
  // The exact event text a tenant saw in the chat on 2026-09-14, when the
  // platform's upstream OpenAI account ran out of credits.
  const UPSTREAM =
    'You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.';

  function withErrors(provider: ResolvedRealtimeVoice['provider']) {
    const fake = new FakeRealtimeSession();
    const errors: string[] = [];
    new RealtimeVoiceSession(
      { ...RESOLVED, provider },
      new BrowserAudioTransport({ sendAudio: () => {}, inputSampleRate: 24000 }),
      {
        tools: [],
        instructions: 'persona',
        executeToolCall: async () => 'ok',
        onError: (e) => errors.push(e),
        sessionFactory: () => fake as unknown as RealtimeSession,
      },
    );
    return { fake, errors };
  }

  test('a hosted session never passes the upstream provider text to the error sink', () => {
    const { fake, errors } = withErrors('usejarvis_ai');
    const warn = console.warn;
    const logged: string[] = [];
    console.warn = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    try {
      fake.errorCb!(UPSTREAM);
    } finally {
      console.warn = warn;
    }
    expect(errors).toHaveLength(1);
    expect(errors[0]).not.toContain('credits');
    expect(errors[0]).not.toContain('platform.openai.com');
    expect(errors[0]).toContain('try again');
    // Operators still get the original, in the daemon log only.
    expect(logged.some((l) => l.includes('no credits remaining'))).toBe(true);
  });

  test('a BYO OpenAI session keeps the provider text (the account is the user\'s own)', () => {
    const { fake, errors } = withErrors('openai');
    fake.errorCb!(UPSTREAM);
    expect(errors).toEqual([UPSTREAM]);
  });
});

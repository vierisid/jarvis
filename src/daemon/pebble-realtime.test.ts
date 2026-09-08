import { test, expect, describe, afterEach } from 'bun:test';
import { PebbleRealtimeManager, foldTranscript, newTranscriptAccumulator } from './pebble-realtime.ts';
import { clearRealtimeGateCache } from './realtime-gate.ts';
import type { ResolvedRealtimeVoice } from '../config/realtime.ts';
import type { RealtimeVoiceSession, RealtimeVoiceDeps } from './realtime-voice.ts';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  clearRealtimeGateCache();
});

const hostedResolved = (): ResolvedRealtimeVoice => ({
  provider: 'usejarvis_ai',
  url: 'wss://llm.usejarvis.host/v1/realtime',
  modelsUrl: 'https://llm.usejarvis.host/v1/models',
  apiKey: 'sk-uj-abc',
  model: 'uj-realtime',
  reasoningEffort: 'low',
  maxSessionMinutes: 10,
  blockedCategories: [],
});

const makeManager = (over: Partial<ConstructorParameters<typeof PebbleRealtimeManager>[0]> = {}) =>
  new PebbleRealtimeManager({
    dispatchRPC: async () => undefined,
    dispatchNotify: () => {},
    getAudioChannel: () => null,
    resolve: () => ({ ok: true, resolved: hostedResolved() }),
    tools: () => [],
    instructions: () => 'test',
    executeToolCall: async () => 'ok',
    ...over,
  });

describe('start/stop race across the plan gate', () => {
  // pr6#2 regression: before the gate existed, the first await in start() came
  // AFTER sessions.set(), so stop() always found the entry. The gate await
  // opened a window where a stop (summon toggled off, sidecar disconnected)
  // found nothing — and the start then opened a perpetual billed session for a
  // peer that was already gone.
  test('stop() during the gate window cancels the start — no session is opened', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    globalThis.fetch = (async () => {
      await gate;
      return new Response(JSON.stringify({ data: [{ id: 'uj-realtime' }] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const mgr = makeManager();
    const started = mgr.start('sidecar-1');
    mgr.stop('sidecar-1'); // arrives while start() is parked on the gate
    release();
    await started;
    expect(mgr.isActive('sidecar-1')).toBe(false);
  });

  test('a quick stop→start toggle mid-gate is adopted by the parked start', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    globalThis.fetch = (async () => {
      await gate;
      // Refuse the plan so the adopted start terminates before dialing a
      // real websocket — the assertion is about the token, not the dial.
      return new Response(JSON.stringify({ data: [{ id: 'uj-chat' }] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const statuses: string[] = [];
    const mgr = makeManager({ onStatus: (_id, status) => { statuses.push(status); } });
    const started = mgr.start('sidecar-1');
    mgr.stop('sidecar-1');
    const second = mgr.start('sidecar-1'); // revives the parked start
    release();
    await Promise.all([started, second]);
    // The refusal surfaced (the parked start ran to completion for the new
    // request) rather than being silently swallowed by the cancelled token.
    expect(statuses).toContain('closed');
    expect(mgr.isActive('sidecar-1')).toBe(false);
  });

  // pr6#7: the summon key only reaches start() because configure_realtime said
  // realtime was on. On a definitive plan refusal the sidecar must be told to
  // downgrade to one-shot capture, not left to error on every summon press.
  test('a plan refusal re-advertises so the sidecar falls back to one-shot', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: [{ id: 'uj-chat' }] }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch;

    const readvertised: string[] = [];
    const statuses: Array<{ status: string; detail?: string }> = [];
    const mgr = makeManager({
      readvertise: (id) => { readvertised.push(id); },
      onStatus: (_id, status, detail) => { statuses.push({ status, detail }); },
    });
    await mgr.start('sidecar-1');
    expect(mgr.isActive('sidecar-1')).toBe(false);
    expect(readvertised).toEqual(['sidecar-1']);
    // Surfaced as a lifecycle close (informative), not an error flash.
    expect(statuses.some((s) => s.status === 'closed')).toBe(true);
    expect(statuses.some((s) => s.status === 'error')).toBe(false);
  });
});

// The Windows report behind this: realtime was advertised as available (the
// plan gate says the alias is included), the summon hotkey opened a session,
// and the server dropped it half a second later. Every press did the same thing
// -- the pebble flashed listening and fell back to idle -- so Ctrl+Space looked
// dead while the wake word kept working. A press has to fall back to one-shot
// capture instead of re-opening a session the server will not serve.
describe('a session that never becomes usable downgrades the summon hotkey', () => {
  /** The plan gate says the alias IS included, so start() reaches the dial. */
  const planAllows = () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: [{ id: 'uj-realtime' }] }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch;
  };

  /** Stand-in for the websocket session, so no test ever dials for real. */
  const fakeSession = (connect: () => Promise<void>) => {
    let voiceDeps: RealtimeVoiceDeps | null = null;
    const createSession = ((_r: unknown, _t: unknown, deps: RealtimeVoiceDeps) => {
      voiceDeps = deps;
      return { connect, close: () => {}, interrupt: () => {} } as unknown as RealtimeVoiceSession;
    }) as NonNullable<ConstructorParameters<typeof PebbleRealtimeManager>[0]['createSession']>;
    return { createSession, deps: () => voiceDeps! };
  };

  test('a refused dial downgrades the sidecar to one-shot capture', async () => {
    planAllows();
    const unusable: Array<{ id: string; detail: string }> = [];
    const fake = fakeSession(async () => {
      throw new Error('realtime socket closed before it opened (code 1008: not in plan)');
    });
    const mgr = makeManager({
      createSession: fake.createSession,
      onUnusableSession: (id, detail) => { unusable.push({ id, detail }); },
    });
    await mgr.start('sidecar-1');
    expect(mgr.isActive('sidecar-1')).toBe(false);
    expect(unusable).toHaveLength(1);
    // The close code is the server's only explanation; it has to reach the log.
    expect(unusable[0]!.detail).toContain('1008');
  });

  test('a session that opens and dies before a single word also downgrades', async () => {
    planAllows();
    const unusable: string[] = [];
    const fake = fakeSession(async () => {});
    const mgr = makeManager({ createSession: fake.createSession, onUnusableSession: (id) => { unusable.push(id); } });
    await mgr.start('sidecar-1');
    expect(mgr.isActive('sidecar-1')).toBe(true);
    fake.deps().onClose?.('code 1011: upstream closed');
    expect(unusable).toEqual(['sidecar-1']);
    expect(mgr.isActive('sidecar-1')).toBe(false);
  });

  test('a conversation that ran does NOT downgrade when it ends', async () => {
    planAllows();
    const unusable: string[] = [];
    const fake = fakeSession(async () => {});
    const mgr = makeManager({ createSession: fake.createSession, onUnusableSession: (id) => { unusable.push(id); } });
    await mgr.start('sidecar-1');
    // One real turn is the whole difference: the server served this session, so
    // its ending says nothing about whether the next one can open.
    fake.deps().onTranscript?.({ role: 'user', text: 'what time is it', final: true });
    fake.deps().onClose?.('code 1000');
    expect(unusable).toEqual([]);
    expect(mgr.isActive('sidecar-1')).toBe(false);
  });
});

describe('foldTranscript', () => {
  test('assistant deltas accumulate — fragments are not cumulative text', () => {
    const acc = newTranscriptAccumulator();
    const first = foldTranscript(acc, { role: 'assistant', text: 'Sure,', final: false }, 1000);
    expect(first).toEqual({ state: 'speaking', text: 'Sure,' });
    // Within the throttle window: buffered, not emitted.
    expect(foldTranscript(acc, { role: 'assistant', text: ' here', final: false }, 1100)).toBeNull();
    expect(foldTranscript(acc, { role: 'assistant', text: ' it', final: false }, 1200)).toBeNull();
    // Past the throttle window: the full buffer so far, not just the last fragment.
    const later = foldTranscript(acc, { role: 'assistant', text: ' is.', final: false }, 1500);
    expect(later).toEqual({ state: 'speaking', text: 'Sure, here it is.' });
  });

  test('assistant final always emits the complete utterance', () => {
    const acc = newTranscriptAccumulator();
    foldTranscript(acc, { role: 'assistant', text: 'Sure,', final: false }, 1000);
    foldTranscript(acc, { role: 'assistant', text: ' here', final: false }, 1050);
    // Final arrives inside the throttle window and still emits, with the
    // event's own full text (the .done payload carries the whole transcript).
    const fin = foldTranscript(acc, { role: 'assistant', text: 'Sure, here you go.', final: true }, 1100);
    expect(fin).toEqual({ state: 'speaking', text: 'Sure, here you go.' });
    // Buffer reset: the next utterance starts clean.
    const next = foldTranscript(acc, { role: 'assistant', text: 'Also,', final: false }, 1200);
    expect(next).toEqual({ state: 'speaking', text: 'Also,' });
  });

  test('user final flips to listening and resets the buffer', () => {
    const acc = newTranscriptAccumulator();
    foldTranscript(acc, { role: 'assistant', text: 'Hello', final: false }, 1000);
    const user = foldTranscript(acc, { role: 'user', text: 'stop', final: true }, 1100);
    expect(user).toEqual({ state: 'listening' });
    expect(acc.buffer).toBe('');
  });

  test('user deltas emit nothing', () => {
    const acc = newTranscriptAccumulator();
    expect(foldTranscript(acc, { role: 'user', text: 'he', final: false }, 1000)).toBeNull();
  });
});

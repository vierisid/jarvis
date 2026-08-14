import { afterEach, describe, expect, test } from 'bun:test';
import { cachedRealtimeVerdict, clearRealtimeGateCache, hostedRealtimeIncluded } from './realtime-gate.ts';
import type { ResolvedRealtimeVoice } from '../config/realtime.ts';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  clearRealtimeGateCache();
});

const hosted = (over: Partial<ResolvedRealtimeVoice> = {}): ResolvedRealtimeVoice => ({
  provider: 'usejarvis_ai',
  url: 'wss://llm.usejarvis.host/v1/realtime',
  modelsUrl: 'https://llm.usejarvis.host/v1/models',
  apiKey: 'sk-uj-abc',
  model: 'uj-realtime',
  maxSessionMinutes: 10,
  ...over,
} as ResolvedRealtimeVoice);

const catalog = (...ids: string[]) =>
  new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });

describe('hostedRealtimeIncluded', () => {
  test('BYO sessions (no modelsUrl) short-circuit without touching the network', async () => {
    let called = 0;
    globalThis.fetch = (async () => { called++; return catalog(); }) as unknown as typeof fetch;
    expect(await hostedRealtimeIncluded(hosted({ modelsUrl: undefined, provider: 'openai' }))).toBe(true);
    expect(called).toBe(0);
  });

  test('gates on the catalog verdict: alias present allows, absent refuses', async () => {
    globalThis.fetch = (async () => catalog('uj-chat', 'uj-realtime')) as unknown as typeof fetch;
    expect(await hostedRealtimeIncluded(hosted())).toBe(true);
    clearRealtimeGateCache();
    globalThis.fetch = (async () => catalog('uj-chat', 'uj-low')) as unknown as typeof fetch;
    expect(await hostedRealtimeIncluded(hosted())).toBe(false);
  });

  test('caches the verdict so a session does not pay a catalog RTT per utterance', async () => {
    let called = 0;
    globalThis.fetch = (async () => { called++; return catalog('uj-realtime'); }) as unknown as typeof fetch;
    await hostedRealtimeIncluded(hosted());
    await hostedRealtimeIncluded(hosted());
    await hostedRealtimeIncluded(hosted());
    expect(called).toBe(1);
  });

  // The plan is enforced by the KEY's allowlist, so an upgrade rewrites the
  // key while base_url and model stay put. Keying the cache on the URL alone
  // would serve the stale "excluded" verdict after the user paid.
  test('a new key is a new cache identity (plan upgrades take effect at once)', async () => {
    globalThis.fetch = (async () => catalog('uj-chat')) as unknown as typeof fetch;
    expect(await hostedRealtimeIncluded(hosted({ apiKey: 'sk-uj-old' }))).toBe(false);
    globalThis.fetch = (async () => catalog('uj-chat', 'uj-realtime')) as unknown as typeof fetch;
    expect(await hostedRealtimeIncluded(hosted({ apiKey: 'sk-uj-new' }))).toBe(true);
  });

  test('a hard timeout bounds the fetch, and a stall is advisory-allow', async () => {
    globalThis.fetch = ((_url: string, init?: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    })) as unknown as typeof fetch;
    const started = Date.now();
    expect(await hostedRealtimeIncluded(hosted())).toBe(true);
    // Must not hang voice_start: the gate's own budget is 1.5s.
    expect(Date.now() - started).toBeLessThan(4_000);
  }, 10_000);

  test('an unreachable catalog is advisory-allow and is not re-fetched per session', async () => {
    let called = 0;
    globalThis.fetch = (async () => { called++; throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    expect(await hostedRealtimeIncluded(hosted())).toBe(true);
    expect(await hostedRealtimeIncluded(hosted())).toBe(true);
    expect(called).toBe(1); // advisory verdicts are cached (briefly)
  });

  test('a non-2xx catalog is advisory-allow — only a definitive catalog gates', async () => {
    globalThis.fetch = (async () => new Response('bad gateway', { status: 502 })) as unknown as typeof fetch;
    expect(await hostedRealtimeIncluded(hosted())).toBe(true);
  });
});

describe('cachedRealtimeVerdict', () => {
  test('never fetches, and reports unknown until the gate has run', async () => {
    let called = 0;
    globalThis.fetch = (async () => { called++; return catalog('uj-chat'); }) as unknown as typeof fetch;
    expect(cachedRealtimeVerdict(hosted())).toBeNull();
    expect(called).toBe(0);
    await hostedRealtimeIncluded(hosted());
    expect(cachedRealtimeVerdict(hosted())).toBe(false);
    expect(called).toBe(1); // the cached read added no traffic
  });

  test('BYO is known-allowed without any catalog', () => {
    expect(cachedRealtimeVerdict(hosted({ modelsUrl: undefined }))).toBe(true);
  });
});

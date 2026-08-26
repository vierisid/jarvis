import { afterEach, describe, expect, test } from 'bun:test';
import {
  ageRealtimeGateCacheForTest,
  cachedRealtimeVerdict,
  clearRealtimeGateCache,
  hostedRealtimeIncluded,
  settleRealtimeGateForTest,
  warmRealtimeGate,
} from './realtime-gate.ts';
import type { ResolvedRealtimeVoice } from '../config/realtime.ts';

/** Mirrors ADVISORY_TTL_MS in realtime-gate.ts (not exported). */
const ADVISORY_TTL_MS = 30_000;

/**
 * Warming exists because realtime is now on by default for hosted tenants, so
 * the plan gate runs for EVERY hosted install. With a cold cache the browser
 * captures raw PCM, the gate refuses, and those frames are dropped — the user
 * speaks and nothing happens. One catalog request at boot removes it.
 */

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  clearRealtimeGateCache();
});

const hosted = (over: Partial<ResolvedRealtimeVoice> = {}): ResolvedRealtimeVoice =>
  ({
    apiKey: 'sk-uj-x',
    provider: 'usejarvis_ai',
    url: 'wss://llm.example/v1/realtime',
    modelsUrl: 'https://llm.example/v1/models',
    model: 'uj-realtime',
    reasoningEffort: 'low',
    maxSessionMinutes: 10,
    blockedCategories: [],
    ...over,
  }) as ResolvedRealtimeVoice;

function catalog(ids: string[]) {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return () => calls;
}

/** The warm is fire-and-forget; await the actual in-flight request rather than
 *  a bare setTimeout(0), which only works while the mocked body resolves inside
 *  one macrotask flush — and whose failure mode is a test that passes against
 *  an unsettled fetch. */
const settle = () => settleRealtimeGateForTest();

describe('warming the plan gate', () => {
  test('a plan WITHOUT realtime is known before anyone speaks', async () => {
    // The point of the whole thing: without this, the first /api/config/voice
    // says "available" (unknown reads as open), the browser captures PCM, and
    // the utterance is refused and dropped.
    const calls = catalog(['uj-chat', 'uj-low']);
    expect(cachedRealtimeVerdict(hosted())).toBeNull();
    warmRealtimeGate(hosted());
    await settle();
    expect(cachedRealtimeVerdict(hosted())).toBe(false);
    expect(calls()).toBe(1);
  });

  test('a plan WITH realtime warms to included', async () => {
    catalog(['uj-chat', 'uj-realtime']);
    warmRealtimeGate(hosted());
    await settle();
    expect(cachedRealtimeVerdict(hosted())).toBe(true);
  });

  test('a voice_start racing the warm shares ONE request, not two', async () => {
    // Both go through fetchVerdict's in-flight dedup. A second catalog request
    // during boot would be pure waste, and on a cold proxy a slow one.
    const calls = catalog(['uj-realtime']);
    warmRealtimeGate(hosted());
    expect(await hostedRealtimeIncluded(hosted())).toBe(true);
    expect(calls()).toBe(1);
  });

  test('a BYO session is never gated, so never warmed', async () => {
    // No modelsUrl = the user's own OpenAI key; there is no plan to consult.
    const calls = catalog(['uj-realtime']);
    warmRealtimeGate(hosted({ modelsUrl: undefined }));
    await settle();
    expect(calls()).toBe(0);
  });

  test('a failed warm does not pin an answer', async () => {
    // It records an advisory (short-lived) entry, so the next real session
    // re-asks rather than trusting a guess made at boot.
    globalThis.fetch = (async () => { throw new Error('proxy not up yet'); }) as unknown as typeof fetch;
    warmRealtimeGate(hosted());
    await settle();
    const calls = catalog(['uj-chat']);
    warmRealtimeGate(hosted());
    await settle();
    expect(calls()).toBe(1);
    expect(cachedRealtimeVerdict(hosted())).toBe(false);
  });

  test('a DEFINITIVE verdict is not re-fetched', async () => {
    const calls = catalog(['uj-chat']);
    warmRealtimeGate(hosted());
    await settle();
    warmRealtimeGate(hosted());
    await settle();
    expect(calls()).toBe(1);
  });
});

describe('the cache is cleared more often than boot', () => {
  test('a cleared cache re-warms to the same verdict', async () => {
    // reloadAll clears this cache on every SIGHUP, which hosted ops do
    // routinely — including the key rotation that carries a plan change. The
    // daemon re-warms at the clear rather than waiting for a voice_start.
    catalog(['uj-chat']);
    warmRealtimeGate(hosted());
    await settle();
    expect(cachedRealtimeVerdict(hosted())).toBe(false);

    clearRealtimeGateCache();
    expect(cachedRealtimeVerdict(hosted())).toBeNull(); // and starts a fetch
    await settle();
    expect(cachedRealtimeVerdict(hosted())).toBe(false);
  });

  test('a failed re-warm does not blind the poll for ever', async () => {
    // The production shape, with NO artificial clear: SIGHUP clears the cache
    // and re-warms; the proxy is restarting (which is what correlates with a
    // key-rotation SIGHUP) so that warm fails and parks an advisory entry.
    //
    // Entries are never deleted, so that advisory does not expire back to
    // absent — it becomes a stale HIT. While the read treated a stale hit as
    // "unknown, don't ask", every later poll answered available and never
    // fetched again: on an excluded plan, the lost utterance permanently.
    globalThis.fetch = (async () => { throw new Error('proxy not up yet'); }) as unknown as typeof fetch;
    warmRealtimeGate(hosted());
    await settle();
    expect(cachedRealtimeVerdict(hosted())).toBe(true); // advisory-open, briefly

    ageRealtimeGateCacheForTest(ADVISORY_TTL_MS + 1_000);
    const calls = catalog(['uj-chat']); // proxy is back
    expect(cachedRealtimeVerdict(hosted())).toBeNull(); // stale ⇒ ask again
    await settle();
    expect(calls()).toBe(1);
    expect(cachedRealtimeVerdict(hosted())).toBe(false);
  });

  test('a failed refresh does NOT flip a known-excluded plan back to open', async () => {
    // advisoryAllow used to overwrite unconditionally, so a stale definitive
    // "excluded" whose background refresh failed read as available for 30s —
    // flipping the browser into PCM capture and costing an utterance, which is
    // the exact flap the asymmetric decay exists to prevent.
    catalog(['uj-chat']);
    warmRealtimeGate(hosted());
    await settle();
    expect(cachedRealtimeVerdict(hosted())).toBe(false);

    // Past CACHE_TTL_MS (10 min), not merely a minute: a definitive entry is
    // FRESH for ten, so ageing by 60s left it fresh, no refresh was kicked and
    // this test passed with the guard reverted.
    ageRealtimeGateCacheForTest(11 * 60_000);
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts++;
      throw new Error('catalog down');
    }) as unknown as typeof fetch;
    expect(cachedRealtimeVerdict(hosted())).toBe(false); // kicks the refresh
    await settle();
    expect(attempts).toBe(1); // the refresh really ran, and really failed
    expect(cachedRealtimeVerdict(hosted())).toBe(false); // still excluded
  });
});

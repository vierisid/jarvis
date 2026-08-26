import { afterEach, describe, expect, test } from 'bun:test';
import {
  cachedRealtimeVerdict,
  clearRealtimeGateCache,
  hostedRealtimeIncluded,
  warmRealtimeGate,
} from './realtime-gate.ts';
import type { ResolvedRealtimeVoice } from '../config/realtime.ts';

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

/** The warm is fire-and-forget; let its in-flight promise settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

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

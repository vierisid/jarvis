import { afterEach, describe, expect, test } from 'bun:test';
import { ageRealtimeGateCacheForTest, cachedRealtimeVerdict, clearRealtimeGateCache, hostedRealtimeIncluded } from './realtime-gate.ts';
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

  // A rotated/revoked key is a definitive "not entitled", not a network blip:
  // advisory-allow here re-dialed a session the proxy is certain to refuse,
  // repeating the stall + failed dial every advisory window.
  test('401/403 from the catalog is a definitive refusal, cached like one', async () => {
    let called = 0;
    globalThis.fetch = (async () => { called++; return new Response('unauthorized', { status: 401 }); }) as unknown as typeof fetch;
    expect(await hostedRealtimeIncluded(hosted())).toBe(false);
    expect(await hostedRealtimeIncluded(hosted())).toBe(false);
    expect(called).toBe(1); // cached with the definitive TTL, not the advisory one
    expect(cachedRealtimeVerdict(hosted())).toBe(false);
  });

  test('concurrent gate calls share one in-flight catalog fetch', async () => {
    let called = 0;
    let release!: () => void;
    const gateOpen = new Promise<void>((r) => { release = r; });
    globalThis.fetch = (async () => { called++; await gateOpen; return catalog('uj-realtime'); }) as unknown as typeof fetch;
    const [a, b, c] = [hostedRealtimeIncluded(hosted()), hostedRealtimeIncluded(hosted()), hostedRealtimeIncluded(hosted())];
    release();
    expect(await Promise.all([a, b, c])).toEqual([true, true, true]);
    expect(called).toBe(1);
  });
});

// pr6#3 regression: a definitive "excluded" that merely EXPIRED must not read
// as unknown/open — /api/config/voice maps unknown to available:true, which
// flips the browser back into raw-PCM capture once per TTL window and costs
// the user that utterance. Decay is a background re-fetch, not an open door.
describe('expired definitive refusals', () => {
  test('hostedRealtimeIncluded answers false immediately and refreshes in the background', async () => {
    globalThis.fetch = (async () => catalog('uj-chat')) as unknown as typeof fetch;
    expect(await hostedRealtimeIncluded(hosted())).toBe(false);
    ageRealtimeGateCacheForTest(11 * 60_000);
    // Refetch now hangs — the answer must come from the stale verdict, not the wire.
    let refetches = 0;
    globalThis.fetch = ((_url: string, init?: { signal?: AbortSignal }) => {
      refetches++;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }) as unknown as typeof fetch;
    const started = Date.now();
    expect(await hostedRealtimeIncluded(hosted())).toBe(false);
    expect(Date.now() - started).toBeLessThan(500); // no stall on the stale-false path
    expect(refetches).toBe(1); // the background refresh did go out
  });

  test('cachedRealtimeVerdict reads an expired refusal as false, never null', async () => {
    globalThis.fetch = (async () => catalog('uj-chat')) as unknown as typeof fetch;
    await hostedRealtimeIncluded(hosted());
    ageRealtimeGateCacheForTest(11 * 60_000);
    expect(cachedRealtimeVerdict(hosted())).toBe(false);
  });

  test('an upgrade still lands: the background refresh flips the verdict', async () => {
    globalThis.fetch = (async () => catalog('uj-chat')) as unknown as typeof fetch;
    expect(await hostedRealtimeIncluded(hosted())).toBe(false);
    ageRealtimeGateCacheForTest(11 * 60_000);
    globalThis.fetch = (async () => catalog('uj-chat', 'uj-realtime')) as unknown as typeof fetch;
    expect(await hostedRealtimeIncluded(hosted())).toBe(false); // stale answer, refresh kicked off
    await Bun.sleep(10); // let the background fetch settle
    expect(await hostedRealtimeIncluded(hosted())).toBe(true);
  });

  test('an expired advisory verdict still decays to unknown (re-fetch, not false)', async () => {
    globalThis.fetch = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    expect(await hostedRealtimeIncluded(hosted())).toBe(true); // advisory
    ageRealtimeGateCacheForTest(60_000);
    expect(cachedRealtimeVerdict(hosted())).toBeNull();
    globalThis.fetch = (async () => catalog('uj-realtime')) as unknown as typeof fetch;
    expect(await hostedRealtimeIncluded(hosted())).toBe(true); // real fetch this time
  });
});

describe('cachedRealtimeVerdict', () => {
  test('a MISS answers unknown at once, but starts a fetch so the next read knows', async () => {
    // The contract changed deliberately. "Never fetch" made the boot warm the
    // ONLY defence against a cold cache — and reloadAll clears this cache on
    // every SIGHUP, which hosted ops do routinely. Starting a background fetch
    // makes the dashboard poll self-healing instead.
    let called = 0;
    globalThis.fetch = (async () => { called++; return catalog('uj-chat'); }) as unknown as typeof fetch;
    // Still null for THIS read: a poll must never stall on the catalog.
    expect(cachedRealtimeVerdict(hosted())).toBeNull();
    expect(called).toBe(1);
    await hostedRealtimeIncluded(hosted()); // joins the in-flight request
    expect(cachedRealtimeVerdict(hosted())).toBe(false);
    expect(called).toBe(1); // ...and added no traffic of its own
  });

  test('repeated misses while the fetch is in flight do not pile up requests', async () => {
    // GET /api/config/voice is polled every ~15s per dashboard; a miss that
    // issued a request per read would turn a UI refresh into catalog traffic,
    // which is the reason this function is cache-only in the first place.
    let called = 0;
    globalThis.fetch = (async () => { called++; return catalog('uj-chat'); }) as unknown as typeof fetch;
    cachedRealtimeVerdict(hosted());
    cachedRealtimeVerdict(hosted());
    cachedRealtimeVerdict(hosted());
    expect(called).toBe(1);
  });

  test('BYO is known-allowed without any catalog', () => {
    expect(cachedRealtimeVerdict(hosted({ modelsUrl: undefined }))).toBe(true);
  });
});

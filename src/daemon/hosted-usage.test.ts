import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import type { JarvisConfig } from '../config/types.ts';
import {
  makeHostedUsageReader,
  readHostedUsageConfig,
  USAGE_CACHE_MS,
  type HostedUsageMeter,
} from './hosted-usage.ts';

const METER: HostedUsageMeter = {
  entitled: true,
  blocked: false,
  sessionPct: 40,
  weekPct: 12,
  sessionResetsAt: '2026-08-26T12:00:00.000Z',
  weekResetsAt: '2026-08-31T00:00:00.000Z',
};

const SECRET = 'a'.repeat(64);
const configWith = (over: Record<string, unknown> = {}): JarvisConfig =>
  ({
    usejarvis_ai: {
      base_url: 'https://llm.example/v1',
      api_key: 'sk-uj-x',
      usage_url: 'https://cp.example/api/llm/instance-usage',
      instance_id: 'inst-1',
      usage_secret: SECRET,
      ...over,
    },
  }) as unknown as JarvisConfig;

/** A fetch that records what it was given and answers with `reply`. */
function stubFetch(reply: () => Response) {
  const calls: Array<{ url: string; body: string; signature: string | null }> = [];
  const fn = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({
      url: String(input),
      body: String(init?.body ?? ''),
      signature: new Headers(init?.headers).get('x-jarvis-signature'),
    });
    return reply();
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const ok = () => new Response(JSON.stringify(METER), { status: 200 });

describe('hosted usage reader', () => {
  test('all three fields or the meter is OFF', () => {
    // A partial set cannot authenticate, so treating it as present would poll a
    // control plane that answers 401 every minute.
    expect(readHostedUsageConfig(configWith())).toEqual({
      url: 'https://cp.example/api/llm/instance-usage',
      instanceId: 'inst-1',
      secret: SECRET,
    });
    expect(readHostedUsageConfig(configWith({ usage_secret: '' }))).toBeNull();
    expect(readHostedUsageConfig(configWith({ instance_id: undefined }))).toBeNull();
    expect(readHostedUsageConfig(configWith({ usage_url: '   ' }))).toBeNull();
    expect(readHostedUsageConfig({} as JarvisConfig)).toBeNull();
  });

  test('signs the EXACT bytes it sends, with the usage secret', async () => {
    const { fn, calls } = stubFetch(ok);
    const read = makeHostedUsageReader({ fetchImpl: fn, now: () => 1_000 });
    expect(await read(configWith())).toEqual(METER);

    const call = calls[0]!;
    expect(call.url).toBe('https://cp.example/api/llm/instance-usage');
    // The signature must cover the body verbatim — signing a re-serialised
    // copy is how a working client starts failing on a key order change.
    expect(call.signature).toBe(
      createHmac('sha256', SECRET).update(call.body).digest('hex'),
    );
    // The timestamp rides INSIDE the signed bytes, which is what bounds replay.
    expect(JSON.parse(call.body)).toEqual({
      instanceId: 'inst-1',
      at: new Date(1_000).toISOString(),
    });
  });

  test('one request per cache window, shared by every caller', async () => {
    // The room's poll and the threshold check must share a request, not take
    // one each.
    let clock = 0;
    const { fn, calls } = stubFetch(ok);
    const read = makeHostedUsageReader({ fetchImpl: fn, now: () => clock });
    await read(configWith());
    await read(configWith());
    clock = USAGE_CACHE_MS - 1;
    await read(configWith());
    expect(calls).toHaveLength(1);
    clock = USAGE_CACHE_MS + 1;
    await read(configWith());
    expect(calls).toHaveLength(2);
  });

  test('a ROTATED secret invalidates the cache instead of signing with the old one', async () => {
    // config.yaml's system block is re-read on SIGHUP precisely so a key can be
    // rotated without a restart; serving a cached minute would answer with a
    // reading obtained under a key we no longer hold.
    const { fn, calls } = stubFetch(ok);
    const read = makeHostedUsageReader({ fetchImpl: fn, now: () => 0 });
    await read(configWith());
    await read(configWith({ usage_secret: 'b'.repeat(64) }));
    expect(calls).toHaveLength(2);
    expect(calls[1]!.signature).toBe(
      createHmac('sha256', 'b'.repeat(64)).update(calls[1]!.body).digest('hex'),
    );
  });

  test('a FAILURE is cached too, so an outage is not one request per render', async () => {
    let clock = 0;
    const { fn, calls } = stubFetch(() => new Response('nope', { status: 502 }));
    const read = makeHostedUsageReader({ fetchImpl: fn, now: () => clock });
    expect(await read(configWith())).toBeNull();
    clock = USAGE_CACHE_MS - 1;
    expect(await read(configWith())).toBeNull();
    expect(calls).toHaveLength(1);
  });

  test('an unrecognised shape reads as UNAVAILABLE, never a meter of undefineds', async () => {
    const { fn } = stubFetch(() => new Response(JSON.stringify({ hello: 'world' }), { status: 200 }));
    const read = makeHostedUsageReader({ fetchImpl: fn, now: () => 0 });
    expect(await read(configWith())).toBeNull();
  });

  test('a missing sessionPct stays NULL rather than becoming zero', async () => {
    // The control plane sends null when it could not read the proxy. Rendering
    // that as 0% would tell a user their window is empty when it may be full.
    const { fn } = stubFetch(
      () => new Response(JSON.stringify({ ...METER, sessionPct: null }), { status: 200 }),
    );
    const read = makeHostedUsageReader({ fetchImpl: fn, now: () => 0 });
    const meter = await read(configWith());
    expect(meter?.sessionPct).toBeNull();
    expect(meter?.weekPct).toBe(12);
  });

  test('an unreachable control plane is null, and never throws at the caller', async () => {
    const fn = (async () => {
      throw new Error('connect ECONNREFUSED https://cp.example');
    }) as unknown as typeof fetch;
    const read = makeHostedUsageReader({ fetchImpl: fn, now: () => 0 });
    expect(await read(configWith())).toBeNull();
  });
});

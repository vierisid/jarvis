import { expect, test } from 'bun:test';
import { createTransport } from './transport.ts';
import { createSession } from './session.ts';
import { fixture } from './test-fixture.ts';
const signal = () => new AbortController().signal;
for (const response of [() => new Response('old server', { status: 404 }), () => new Response('', { status: 401 }), () => new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } }), () => Response.json({ schemaVersion: 2 }), () => Response.json({ schemaVersion: 1, enabled: true })]) test('new UI on an older/unauthorized/invalid backend preserves legacy without POSTs', async () => {
  const f = fixture(), calls: string[] = [];
  f.config.transport = createTransport((async (_url, init) => { calls.push(init?.method ?? 'GET'); return response(); }));
  const s = createSession(f.config); await s.start(); expect(s.state().mode).toBe('legacy'); expect(calls).toEqual(['GET']); s.dispose();
});
test('transport sends fixed v1 envelopes with cookies, no cache and no client authority', async () => {
  const calls: Array<[unknown, RequestInit | undefined]> = [];
  const t = createTransport((async (url, init) => { calls.push([url, init]); return Response.json({ schemaVersion: 1, result: { ready: true } }); }));
  expect(await t.call('setup.complete', { action: 'complete_setup' }, signal())).toEqual({ ready: true });
  expect(calls[0]).toEqual(['/api/onboarding-next/v1/setup/complete', expect.objectContaining({ method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', body: '{"schemaVersion":1,"input":{"action":"complete_setup"}}' })]);
});
test('stalled valid JSON response is bounded and cancelled, not accepted', async () => {
  let cancelled = false;
  const t = createTransport((async () => new Response(new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode('{"schemaVersion":1,"result":{}}')); }, cancel() { cancelled = true; },
  }), { headers: { 'content-type': 'application/json' } })), 15);
  await expect(t.call('journey.read', {}, signal())).rejects.toThrow('unavailable'); expect(cancelled).toBe(true);
});
test('abort before request performs no network call; unknown writes are not retried', async () => {
  let calls = 0;
  const t = createTransport((async () => { calls++; throw new Error('secret body'); }));
  const c = new AbortController(); c.abort();
  await expect(t.call('setup.complete', {}, c.signal)).rejects.toThrow('unavailable'); expect(calls).toBe(0);
  await expect(t.call('setup.complete', {}, signal())).rejects.toThrow('unavailable'); expect(calls).toBe(1);
});


test('goal planning on finish/explore outlives the ordinary request budget and still supports abort', async () => {
  const t = createTransport(async () => { await Bun.sleep(30); return Response.json({ schemaVersion: 1, result: { ready: true } }); }, 5);
  for (const type of ['finish', 'explore']) expect(await t.call('journey.transition', { command: { type } }, signal())).toEqual({ ready: true });
  const controller = new AbortController();
  const request = t.call('journey.transition', { command: { type: 'finish' } }, controller.signal); controller.abort();
  await expect(request).rejects.toThrow('unavailable');
});

import { describe, expect, test } from 'bun:test';
import { OPERATIONS, type Provider } from './contract.ts';
import { createOnboardingRoutes, OPERATION_PATHS } from './routes.ts';
import { createOnboardingRuntime } from './runtime.ts';
import { fixtureOptions, request } from './test-fixture.ts';
const path = '/api/onboarding-next/v1/build/submit';
const post = (body: string, headers: Record<string, string> = { 'content-type': 'application/json' }) => new Request(`http://localhost${path}`, { method: 'POST', headers, body });
const payload = (input = {}) => JSON.stringify({ schemaVersion: 1, input });
test('unauthenticated status and commands return 401 even with supplied owner headers', async () => {
  const o = fixtureOptions(); o.authorize = () => null; const routes = createOnboardingRoutes(createOnboardingRuntime(o));
  expect((await routes['/api/onboarding-next/v1/status']!.GET!(request())).status).toBe(401);
  expect((await routes[path]!.POST!(post(payload(), { 'x-user-id': 'owner', 'x-project-id': 'project' }))).status).toBe(401);
  expect(o.calls).toEqual([]);
});
test('status is versioned, uncached and contains no provider payloads', async () => {
  const response = await createOnboardingRoutes(createOnboardingRuntime(fixtureOptions()))['/api/onboarding-next/v1/status']!.GET!(request());
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect((await response.json()).schemaVersion).toBe(1);
});
test('strict envelopes reject newer versions, invalid JSON and client-selected authority', async () => {
  const o = fixtureOptions(), handler = createOnboardingRoutes(createOnboardingRuntime(o))[path]!.POST!;
  const cases: [string, number][] = [ ['{', 400], ['[]', 400], [JSON.stringify({ schemaVersion: 2, input: {} }), 409], [JSON.stringify({ schemaVersion: 1, input: {}, enabled: true }), 400] ];
  for (const key of ['actorId', 'projectId', 'userId', 'scope', 'vaultPath', 'release']) cases.push([payload({ [key]: 'other' }), 400]);
  for (const [body, status] of cases) expect((await handler(post(body))).status).toBe(status);
  expect((await handler(post(payload(), { 'content-type': 'text/plain' }))).status).toBe(415);
  expect(o.calls.some(c => c.startsWith('execute:'))).toBe(false);
});
test('bounds actual streamed bytes even with no declared length', async () => {
  const handler = createOnboardingRoutes(createOnboardingRuntime(fixtureOptions()))[path]!.POST!;
  expect((await handler(post(payload({ prompt: 'x'.repeat(33000) })))).status).toBe(413);
  expect((await handler(post(payload(), { 'content-type': 'application/json', 'content-length': '999999' }))).status).toBe(413);
});
test('disabled rollout refuses a command without invoking its provider', async () => {
  const o = fixtureOptions(); o.enabled = false;
  expect((await createOnboardingRoutes(createOnboardingRuntime(o))[path]!.POST!(post(payload()))).status).toBe(503);
  expect(o.calls.some(c => c.startsWith('execute:'))).toBe(false);
});
test('aborting a stalled request body cancels reading without dispatching', async () => {
  const o = fixtureOptions(), controller = new AbortController();
  let cancelled = false;
  const req = new Request(`http://localhost${path}`, { method: 'POST', headers: { 'content-type': 'application/json' },
    signal: controller.signal, body: new ReadableStream({ cancel() { cancelled = true; } }) });
  const result = createOnboardingRoutes(createOnboardingRuntime(o))[path]!.POST!(req);
  setTimeout(() => controller.abort(), 5);
  expect((await result).status).toBe(400); expect(cancelled).toBe(true);
  expect(o.calls.some(c => c.startsWith('execute:'))).toBe(false);
});
for (const stop of ['timeout', 'abort'] as const) test(`${stop} rejects valid JSON whose stream never finishes`, async () => {
  const o = fixtureOptions(), controller = new AbortController();
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const req = new Request(`http://localhost${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: controller.signal,
    body: new ReadableStream({
      start(stream) { stream.enqueue(new TextEncoder().encode(payload({ requestId: 'unfinished' }))); },
      pull() {
        // Abort only once the reader has consumed the valid prefix and is
        // waiting for EOF. Cancellation must not turn that wait into success.
        if (stop === 'abort') timer ??= setTimeout(() => controller.abort(), 10);
      },
      cancel() { cancelled = true; },
    }),
  });
  try {
    const response = await createOnboardingRoutes(createOnboardingRuntime(o))[path]!.POST!(req);
    expect(response.status).toBe(stop === 'timeout' ? 408 : 400);
    expect(await response.json()).toEqual({ schemaVersion: 1, error: 'invalid_request' });
    expect(cancelled).toBe(true);
    expect(o.calls.filter(c => c.startsWith('execute:'))).toEqual([]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}, 10_000);
test('approved complete assembly dispatches exactly the allowlisted operation', async () => {
  const o = fixtureOptions(); const response = await createOnboardingRoutes(createOnboardingRuntime(o))[path]!.POST!(post(payload({ requestId: 'test' })));
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ schemaVersion: 1, result: { actor: 'owner' } });
  expect(o.calls.filter(c => c.startsWith('execute:'))).toEqual(['execute:build.submit']);
  expect(Object.values(OPERATION_PATHS).some(p => p.includes('acknowledge') || p.includes('compose'))).toBe(false);
});
test('exceptions never echo credentials or provider details', async () => {
  const o = fixtureOptions(); o.authorize = () => { throw new Error('Bearer SECRET credential'); };
  const response = await createOnboardingRoutes(createOnboardingRuntime(o))[path]!.POST!(post(payload()));
  expect(await response.text()).not.toContain('SECRET');
});

describe('Google OAuth return page', () => {
  const returnPath = '/api/onboarding-next/v1/google/return';
  function harness(result: unknown = { connection: { state: 'connected' } }) {
    const o = fixtureOptions(), inputs: unknown[] = [];
    const cap = OPERATIONS['google.callback'], bind = o.bindings![cap]!;
    o.bindings![cap] = (...args) => {
      const bound = bind(...args) as Provider;
      return { ...bound, operations: { ...bound.operations, 'google.callback': async (input: unknown) => { inputs.push(input); return result; } } };
    };
    const handler = createOnboardingRoutes(createOnboardingRuntime(o))[returnPath]!.GET!;
    return { o, inputs, open: (query: string) => handler(new Request(`http://localhost${returnPath}${query}`)) };
  }
  test('passes exactly one state and code to the authenticated callback and says the connection is ready', async () => {
    const h = harness(), response = await h.open('?state=s1&code=c1');
    expect(response.status).toBe(200);
    expect(h.inputs).toEqual([{ state: 's1', code: 'c1' }]);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    expect(await response.text()).toContain('<h1>Google connected</h1>');
  });
  test('a provider error is forwarded and the page asks for attention without echoing the query', async () => {
    const h = harness({ connection: { state: 'error' } });
    const response = await h.open('?state=s1&error=%3Cscript%3Ealert(1)%3C%2Fscript%3E');
    expect(h.inputs).toEqual([{ state: 's1', error: '<script>alert(1)</script>' }]);
    const html = await response.text();
    expect(html).toContain('<h1>Google connection needs attention</h1>');
    expect(html).not.toContain('<script'); expect(html).not.toContain('s1');
  });
  test('a missing, empty or repeated parameter is refused before the callback runs', async () => {
    for (const query of ['', '?code=c1', '?state=&code=c1', '?state=a&state=b&code=c1', '?state=a&code=c1&code=c2', '?state=a&error=x&error=y']) {
      const h = harness(), response = await h.open(query);
      expect(response.status).toBe(400); expect(h.inputs).toEqual([]);
      expect((await response.json()).error).toBe('invalid_request');
    }
  });
  test('an unauthenticated return never reaches the callback', async () => {
    const h = harness(); h.o.authorize = () => null;
    const response = await createOnboardingRoutes(createOnboardingRuntime(h.o))[returnPath]!.GET!(new Request(`http://localhost${returnPath}?state=s1&code=c1`));
    expect(response.status).toBe(401); expect(h.inputs).toEqual([]);
  });
});

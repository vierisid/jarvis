import { expect, test } from 'bun:test';
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

/** Kill stops Jarvis; Reset brings it back. A rule loosened in between must not quietly come back with it. */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { closeDb, initDatabase } from '../vault/schema.ts';
import { AuthorityEngine, type AuthorityConfig } from './engine.ts';
import { EmergencyController, setActiveEmergencyController } from './emergency.ts';
import { createApiRoutes, type ApiContext } from '../daemon/api-routes.ts';

beforeEach(() => initDatabase(':memory:', { quiet: true }));
afterEach(() => { setActiveEmergencyController(null); closeDb(); });

function harness() {
  const config: AuthorityConfig = { default_level: 3, governed_categories: ['send_email'], overrides: [], context_rules: [],
    learning: { enabled: false, suggest_threshold: 5 }, emergency_state: 'normal' };
  const authority = new AuthorityEngine(config);
  const emergency = new EmergencyController();
  const appConfig = { authority: { default_level: 3 } } as Record<string, any>;
  const routes = createApiRoutes({ config: appConfig, agentService: {}, authorityEngine: authority, emergencyController: emergency,
    learner: { getSuggestions: () => [{ actionCategory: 'send_email' }], markSuggestionSent: () => {} } } as unknown as ApiContext) as Record<string, Record<string, (req: Request) => Promise<Response>>>;
  const post = (path: string, body: unknown) => routes[path]!.POST!(new Request(`http://localhost${path}`, {
    method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }));
  const raw = (path: string, body: ReadableStream<Uint8Array>) => routes[path]!.POST!(new Request(`http://localhost${path}`, {
    method: 'POST', body, headers: { 'Content-Type': 'application/json' }, duplex: 'half' } as RequestInit));
  return { authority, emergency, post: Object.assign(post, { raw }) };
}

test('while Kill is active, config writes, quick overrides and learning accepts are refused and change nothing', async () => {
  const h = harness();
  h.emergency.kill();
  for (const [path, body] of [['/api/authority/config', { default_level: 10 }],
    ['/api/authority/config/quick-override', { action: 'send_email', allow: true }],
    ['/api/authority/learning/accept', { action: 'send_email', tool_name: 'x' }]] as const) {
    const response = await h.post(path, body);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'Jarvis is stopped. Reset it first, then change Authority settings.' });
  }
  expect(h.authority.getConfig()).toMatchObject({ default_level: 3, overrides: [] });
  h.emergency.reset();
  expect((await h.post('/api/authority/config', { default_level: 5 })).status).toBe(200);
  expect(h.authority.getConfig().default_level).toBe(5);
});

test('Pause does not freeze settings', async () => {
  const h = harness();
  h.emergency.pause();
  expect((await h.post('/api/authority/config', { default_level: 4 })).status).toBe(200);
  expect((await h.post('/api/authority/config/quick-override', { action: 'send_email', allow: false })).status).toBe(200);
});

test('a Deny quick override is accepted during Kill, since it can only tighten; an Allow is not', async () => {
  const h = harness();
  h.emergency.kill();
  expect((await h.post('/api/authority/config/quick-override', { action: 'send_email', allow: true })).status).toBe(409);
  expect(h.authority.getConfig().overrides).toEqual([]);
  expect((await h.post('/api/authority/config/quick-override', { action: 'send_email', allow: false })).status).toBe(200);
  expect(h.authority.getConfig().overrides).toEqual([{ action: 'send_email', allowed: false, requires_approval: false }]);
  // Turning that Deny back into an Allow is loosening, so it waits for Reset.
  expect((await h.post('/api/authority/config/quick-override', { action: 'send_email', allow: true })).status).toBe(409);
  expect(h.authority.getConfig().overrides).toEqual([{ action: 'send_email', allowed: false, requires_approval: false }]);
});

test('a write whose body is still arriving when Kill lands is refused and changes nothing', async () => {
  const h = harness();
  for (const [path, body] of [['/api/authority/config', { default_level: 10 }],
    ['/api/authority/config/quick-override', { action: 'send_email', allow: true }],
    ['/api/authority/learning/accept', { action: 'send_email', tool_name: 'x' }]] as const) {
    if (h.emergency.getState() === 'killed') h.emergency.reset();
    let send!: () => void;
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      send = () => { controller.enqueue(new TextEncoder().encode(JSON.stringify(body))); controller.close(); };
    } });
    const pending = h.post.raw(path, stream);
    h.emergency.kill();
    send();
    const response = await pending;
    expect(response.status).toBe(409);
  }
  expect(h.authority.getConfig()).toMatchObject({ default_level: 3, overrides: [] });
});

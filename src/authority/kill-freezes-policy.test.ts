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
  return { authority, emergency, post };
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

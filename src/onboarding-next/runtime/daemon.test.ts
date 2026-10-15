import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDatabase, getDb, closeDb } from '../../vault/schema.ts';
import { DEFAULT_CONFIG } from '../../config/types.ts';
import { createApiRoutes, type ApiContext } from '../../daemon/api-routes.ts';
import { saveUserSection } from '../../daemon/user-settings.ts';
import { setSetting } from '../../vault/settings.ts';
import { PANEL_SESSION_COOKIE } from '../../sidecar/panel-sessions.ts';
import { USER_PROFILE_SETTING_KEY } from '../../user/profile.ts';
import { createDaemonOnboardingRuntime, daemonBindings, readLegacyJourney } from './daemon.ts';
import { createOnboardingRuntime } from './runtime.ts';
import { runtimeModules } from './generated/catalog.ts';
import { fixtureOptions, request } from './test-fixture.ts';
const scope = { actorId: 'jrv_user_default', projectId: 'jrv_proj_default' };
let live = true;
const req = () => new Request('http://localhost/api/onboarding-next/v1/status', { headers: { cookie: `${PANEL_SESSION_COOKIE}=session` } });
function ctx(): ApiContext {
  return {
    daemonStartedAt: 1, config: structuredClone(DEFAULT_CONFIG), healthMonitor: {} as ApiContext['healthMonitor'],
    agentService: { getLLMManager: () => ({ getProviderNames: () => [] }) } as unknown as ApiContext['agentService'],
    sidecarManager: { resolvePanelSession: (id: string) => live && id === 'session' ? { id, sid: 'device' } : null } as unknown as ApiContext['sidecarManager'],
  };
}
let secretsDir: string;
let previousSecrets: string | undefined;
beforeEach(() => {
  previousSecrets = process.env.JARVIS_SECRETS_DIR;
  secretsDir = mkdtempSync(join(tmpdir(), 'on-b-11-secrets-'));
  process.env.JARVIS_SECRETS_DIR = secretsDir;
  closeDb(); initDatabase(':memory:'); live = true;
});
afterEach(() => {
  closeDb();
  if (previousSecrets === undefined) delete process.env.JARVIS_SECRETS_DIR;
  else process.env.JARVIS_SECRETS_DIR = previousSecrets;
  rmSync(secretsDir, { recursive: true, force: true });
});
test('daemon status uses live session auth and never bypasses it in insecure bootstrap mode', async () => {
  const c = ctx(); c.config.auth = { insecure_open_access: true };
  const r = createDaemonOnboardingRuntime(c, runtimeModules);
  await expect(r.status(request())).rejects.toMatchObject({ status: 401 });
  const s = await r.status(req()); expect(s.enabled).toBe(false); expect(s.ready).toBe(false);
  live = false; await expect(r.status(req())).rejects.toMatchObject({ status: 401 });
});
test('hosted without usable proxy remains hosted; unavailable config stays unknown', async () => {
  const c = ctx(); c.config.daemon.listen = 'unix:/tmp/tenant.sock';
  expect((await createDaemonOnboardingRuntime(c, []).status(req())).installMode).toBe('hosted');
  c.config.daemon = undefined as never;
  expect((await createDaemonOnboardingRuntime(c, []).status(req())).installMode).toBe('unknown');
});
test('new status is observational; old endpoints still work without a new client', async () => {
  const c = ctx(); c.onboardingNext = createDaemonOnboardingRuntime(c, runtimeModules);
  const routes = createApiRoutes(c) as Record<string, { GET?: (r: Request) => Promise<Response> }>;
  const before = getDb().query('SELECT * FROM settings').all();
  expect((await routes['/api/onboarding-next/v1/status']!.GET!(req())).status).toBe(200);
  expect(getDb().query('SELECT * FROM settings').all()).toEqual(before);
  const legacy = await routes['/api/onboarding/status']!.GET!(req());
  expect(legacy.status).toBe(200); expect((await legacy.json()).setup_completed).toBe(false);
  expect(createApiRoutes(ctx())['/api/onboarding-next/v1/status']).toBeUndefined();
});
test('legacy completed users remain completed through the real journey factory and SQLite adapter', async () => {
  const entry = runtimeModules.find(m => m.manifest.id === 'ON-B-01');
  if (!entry) { expect((await createDaemonOnboardingRuntime(ctx(), runtimeModules).status(req())).capabilities['journey.v1'].reason).toBe('module_absent'); return; }
  saveUserSection('onboarding', { setup_completed_at: 1, setup_skipped_profile: true, tutorial_completed_at: 2 });
  const o = fixtureOptions(), c = ctx(); o.authorize = () => scope;
  o.modules = o.modules.map(m => m.manifest.id === 'ON-B-01' ? entry : m);
  o.bindings = { ...o.bindings, ...daemonBindings(c, () => live ? scope : null) };
  // Only journey is real. Setup and the other release prerequisites are explicit
  // synthetic fixtures; this proves persistence wiring, not a live release.
  o.bindings['setup.v1'] = fixtureOptions().bindings!['setup.v1'];
  const runtime = createOnboardingRuntime(o);
  const first = await runtime.execute(req(), 'journey.read', {}) as { availability: string; snapshot: { journeyId: string; stepId: string; revision: number } };
  expect(first.availability).toBe('ready'); expect(first.snapshot.stepId).toBe('exited');
  const again = await runtime.execute(req(), 'journey.read', {}) as typeof first;
  expect(again.snapshot.journeyId).toBe(first.snapshot.journeyId);
  const forged = await runtime.execute(req(), 'journey.transition', { journeyId: first.snapshot.journeyId, expectedRevision: first.snapshot.revision, requestId: 'forged', command: { type: 'setup_completed' } }) as { availability: string };
  expect(forged.availability).not.toBe('ready');
  const count = getDb().query('SELECT count(*) as n FROM settings WHERE key LIKE ?').get('onboarding-next.journey.v1.%');
  expect(count).toEqual({ n: 1 });
});
test('corrupt legacy data is unavailable and does not initialize a journey', async () => {
  for (const raw of ['{broken', '[]', '{"setup_completed_at":"wrong"}', '{"setup_skipped_profile":"yes"}']) {
    setSetting('cfg.onboarding', raw);
    expect(() => readLegacyJourney(getDb())).toThrow();
    const s = await createDaemonOnboardingRuntime(ctx(), runtimeModules).status(req());
    expect(s.capabilities['journey.v1'].ready).toBe(false);
    expect(getDb().query('SELECT count(*) as n FROM settings WHERE key LIKE ?').get('onboarding-next.journey.v1.%')).toEqual({ n: 0 });
  }
  setSetting('cfg.onboarding', '{}'); setSetting(USER_PROFILE_SETTING_KEY, '{broken');
  expect(() => readLegacyJourney(getDb())).toThrow();
  setSetting(USER_PROFILE_SETTING_KEY, JSON.stringify({ version: 1, answers: {}, interview_facts: [null] }));
  expect(() => readLegacyJourney(getDb())).toThrow();
});

const setupEntry = runtimeModules.find(m => m.manifest.id === 'ON-B-02');
for (const initiallyRunning of [false, true]) test.skipIf(!setupEntry)(`real optional setup applies live bindings and confirms startup (already running: ${initiallyRunning})`, async () => {
  const c = ctx(), o = fixtureOptions(), applied: string[] = [];
  c.config.usejarvis_ai = { base_url: 'https://proxy.example.test', api_key: 'fixture' };
  saveUserSection('tts', { enabled: false });
  let running = initiallyRunning, fail = true, starts = 0;
  c.onboardingServiceReadiness = () => running ? 'running' : 'stopped';
  c.startPostSetupServices = async () => { starts++; running = true; };
  c.settingsReload = {
    reloadAll: async () => ({ applied: [], errors: [] }),
    applyNow: async (section: string) => { applied.push(section); return fail && section === 'tts' ? { message: 'fixture' } : null; },
  } as unknown as ApiContext['settingsReload'];
  o.authorize = () => live ? scope : null;
  o.modules = o.modules.map(m => runtimeModules.find(real => real.manifest.id === m.manifest.id && ['ON-B-01', 'ON-B-02'].includes(real.manifest.id)) ?? m);
  o.bindings = { ...o.bindings, ...daemonBindings(c, () => live ? scope : null) };
  const runtime = createOnboardingRuntime(o);
  const read = () => runtime.execute(req(), 'journey.read', {}) as Promise<{ snapshot: { revision: number; setupState: string } }>;
  expect((await read()).snapshot.setupState).toBe('pending');
  expect(await runtime.execute(req(), 'setup.complete', { action: 'complete_setup' })).toMatchObject({ ready: false, reason: 'services_start_failed' });
  const completion = c.config.onboarding!.setup_completed_at;
  expect(completion).toBeGreaterThan(0);
  expect(c.config.awareness?.enabled).toBe(false); expect(c.config.tts?.enabled).toBe(false);
  expect(starts).toBe(0); expect((await read()).snapshot.setupState).toBe('pending');
  fail = false;
  expect(await runtime.execute(req(), 'setup.complete', { action: 'complete_setup' })).toMatchObject({ ready: true });
  expect(applied).toEqual(['llm', 'tts', 'llm', 'tts', 'awareness']);
  const confirmed = await read(); expect(confirmed.snapshot.setupState).toBe('completed'); expect(starts).toBe(1);
  await runtime.execute(req(), 'setup.complete', { action: 'complete_setup' });
  expect(c.config.onboarding!.setup_completed_at).toBe(completion);
  expect((await read()).snapshot.revision).toBe(confirmed.snapshot.revision); expect(starts).toBe(1);
});
test.skipIf(!setupEntry)('revocation during setup reload prevents subsequent service effects', async () => {
  const c = ctx(), o = fixtureOptions(); let effects = 0;
  c.config.usejarvis_ai = { base_url: 'https://proxy.example.test', api_key: 'fixture' };
  c.onboardingServiceReadiness = () => 'stopped';
  c.startPostSetupServices = async () => { effects++; };
  c.settingsReload = { reloadAll: async () => { live = false; return { applied: [], errors: [] }; },
    applyNow: async () => { effects++; return null; } } as unknown as ApiContext['settingsReload'];
  o.authorize = () => live ? scope : null;
  o.modules = o.modules.map(m => m.manifest.id === 'ON-B-02' ? setupEntry! : m);
  o.bindings = { ...o.bindings, 'setup.v1': daemonBindings(c, () => live ? scope : null)['setup.v1'] };
  await expect(createOnboardingRuntime(o).execute(req(), 'setup.complete', { action: 'complete_setup' })).rejects.toMatchObject({ status: 401 });
  expect(effects).toBe(0);
});

test('loopback HTTP preserves legacy status and refuses new commands by default', async () => {
  const c = ctx(); c.onboardingNext = createDaemonOnboardingRuntime(c, runtimeModules);
  const routes = createApiRoutes(c) as Record<string, { GET?: (r: Request) => Promise<Response>; POST?: (r: Request) => Promise<Response> }>;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(r) {
    const route = routes[new URL(r.url).pathname];
    const handler = r.method === 'GET' ? route?.GET : r.method === 'POST' ? route?.POST : undefined;
    return handler ? handler(r) : new Response(null, { status: 404 });
  } });
  try {
    const headers = { cookie: `${PANEL_SESSION_COOKIE}=session` };
    expect((await fetch(new URL('/api/onboarding-next/v1/status', server.url))).status).toBe(401);
    const status = await fetch(new URL('/api/onboarding-next/v1/status', server.url), { headers });
    expect(await status.json()).toMatchObject({ schemaVersion: 1, enabled: false, ready: false, released: false });
    const legacy = await fetch(new URL('/api/onboarding/status', server.url), { headers });
    expect(await legacy.json()).toMatchObject({ setup_completed: false });
    expect((await fetch(new URL('/api/onboarding-next/v1/build/submit', server.url), {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{"schemaVersion":1,"input":{}}',
    })).status).toBe(503);
    expect(getDb().query('SELECT count(*) as n FROM settings').get()).toEqual({ n: 0 });
  } finally { await server.stop(true); }
});

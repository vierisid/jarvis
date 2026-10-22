import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDatabase, closeDb } from '../../vault/schema.ts';
import { initWorkflowDb, closeWorkflowDb } from '../../workflows/db';
import { DEFAULT_CONFIG } from '../../config/types.ts';
import type { ApiContext } from '../../daemon/api-routes.ts';
import { PANEL_SESSION_COOKIE } from '../../sidecar/panel-sessions.ts';
import { sampleCatalog } from '../../workflows/runtime/test-fixtures';
import { createDaemonOnboardingAssembly, type DaemonAssemblyOptions } from './daemon-assembly.ts';
import { runtimeModules } from './generated/catalog.ts';

let live = true, secretsDir: string, previousSecrets: string | undefined;
const stops: Array<() => void> = [];
const session = (cookie: string | null = 'session') => new Request('http://localhost/api/onboarding-next/v1/status',
  cookie ? { headers: { cookie: `${PANEL_SESSION_COOKIE}=${cookie}` } } : {});
function ctx(): ApiContext {
  return {
    daemonStartedAt: 1, config: structuredClone(DEFAULT_CONFIG), healthMonitor: {} as ApiContext['healthMonitor'],
    agentService: { getLLMManager: () => ({ getProviderNames: () => ['anthropic'] }) } as unknown as ApiContext['agentService'],
    sidecarManager: { resolvePanelSession: (id: string) => live && id === 'session' ? { id, sid: 'device' } : null } as unknown as ApiContext['sidecarManager'],
    settingsReload: { reloadAll: async () => ({ applied: [], errors: [] }), applyNow: async () => null, sectionChanged: () => {} } as unknown as ApiContext['settingsReload'],
    startPostSetupServices: async () => {}, onboardingServiceReadiness: () => 'running',
  } as ApiContext;
}
function assembly(c: ApiContext, options: Partial<DaemonAssemblyOptions> = {}) {
  const a = createDaemonOnboardingAssembly(c, runtimeModules, { origin: 'http://localhost:3142',
    composer: () => ({ pieceRegistry: sampleCatalog() }) as never, roomStatus: () => 'ready', ...options });
  stops.push(a.stop); return a;
}
beforeEach(() => {
  previousSecrets = process.env.JARVIS_SECRETS_DIR;
  secretsDir = mkdtempSync(join(tmpdir(), 'daemon-assembly-secrets-'));
  process.env.JARVIS_SECRETS_DIR = secretsDir;
  closeDb(); initDatabase(':memory:'); closeWorkflowDb(); initWorkflowDb(':memory:'); live = true;
});
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  closeWorkflowDb(); closeDb();
  if (previousSecrets === undefined) delete process.env.JARVIS_SECRETS_DIR;
  else process.env.JARVIS_SECRETS_DIR = previousSecrets;
  rmSync(secretsDir, { recursive: true, force: true });
});

test('the canonical origin must be a bare http(s) origin', () => {
  for (const origin of ['http://localhost:3142/app/', 'http://user:pass@localhost:3142', 'http://localhost:3142/?x=1', 'http://localhost:3142/#x', 'file:///tmp/x', 'javascript:alert(1)', 'ftp://localhost', 'ws://localhost:3142'])
    expect(() => assembly(ctx(), { origin })).toThrow('Invalid onboarding origin');
  expect(() => assembly(ctx(), { origin: 'https://jarvis.example.com' })).not.toThrow();
});

test('every status and command needs a live panel session', async () => {
  const { runtime } = assembly(ctx(), { localIntegration: true });
  await expect(runtime.status(session(null))).rejects.toMatchObject({ status: 401 });
  await expect(runtime.status(session('forged'))).rejects.toMatchObject({ status: 401 });
  await expect(runtime.execute(session(null), 'journey.read', {})).rejects.toMatchObject({ status: 401 });
  expect((await runtime.status(session())).ready).toBe(true);
  live = false;
  await expect(runtime.status(session())).rejects.toMatchObject({ status: 401 });
});

test('without a release decision or local integration nothing is enabled or dispatched', async () => {
  const { runtime } = assembly(ctx());
  const status = await runtime.status(session());
  expect(status).toMatchObject({ ready: false, released: false, enabled: false });
  expect(status).not.toHaveProperty('integration');
  await expect(runtime.execute(session(), 'journey.read', {})).rejects.toMatchObject({ status: 503 });
});

test('local integration opens a self-hosted vault without claiming a release', async () => {
  const { runtime } = assembly(ctx(), { localIntegration: true });
  expect(await runtime.status(session())).toMatchObject({ ready: true, released: false, enabled: true, integration: true, reason: 'ready' });
  expect(await runtime.execute(session(), 'journey.read', {})).toMatchObject({ availability: 'ready' });
});

test('local integration never authorizes a hosted install', async () => {
  const c = ctx(); c.config.daemon.listen = 'unix:/tmp/tenant.sock';
  const { runtime } = assembly(c, { localIntegration: true });
  const status = await runtime.status(session());
  expect(status).toMatchObject({ installMode: 'hosted', ready: false, released: false });
  expect(status).not.toHaveProperty('integration');
  await expect(runtime.execute(session(), 'journey.read', {})).rejects.toMatchObject({ status: 503 });
});

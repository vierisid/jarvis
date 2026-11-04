import { afterEach, expect, test } from 'bun:test';
import { DEFAULT_CONFIG } from '../config/types';
import { createApiRoutes, type ApiContext } from './api-routes';

const original = process.env.JARVIS_HOSTED_DASHBOARD;
afterEach(() => { if (original === undefined) delete process.env.JARVIS_HOSTED_DASHBOARD; else process.env.JARVIS_HOSTED_DASHBOARD = original; });

test('the real API advertises the hosted default, rollback and self-hosted compatibility without release receipts', async () => {
  for (const mode of ['hosted', 'self'] as const) {
    const config = structuredClone(DEFAULT_CONFIG);
    if (mode === 'hosted') config.daemon.listen = 'unix:/run/jarvis/test.sock';
    const routes = createApiRoutes({ config, daemonStartedAt: Date.now(), healthMonitor: {} } as ApiContext);
    const get = (routes['/api/brief/host'] as { GET(): Response }).GET;
    delete process.env.JARVIS_HOSTED_DASHBOARD;
    const response = get(), descriptor = await response.json();
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(descriptor).toMatchObject({ schemaVersion: 1, installMode: mode, dashboard: mode === 'hosted' ? 'brief' : 'legacy' });
    expect(descriptor).not.toHaveProperty('approval'); expect(descriptor).not.toHaveProperty('gates');
    process.env.JARVIS_HOSTED_DASHBOARD = 'legacy';
    const rollback = await get().json();
    expect(rollback.dashboard).toBe('legacy'); expect(rollback.generation).toBe(descriptor.generation);
  }
});

test('the host descriptor carries the persisted workspace id across boots and a per-boot generation', async () => {
  const boot = () => (createApiRoutes({ config: structuredClone(DEFAULT_CONFIG), workspaceId: 'workspace-one', daemonStartedAt: Date.now(), healthMonitor: {} } as ApiContext)['/api/brief/host'] as { GET(): Response }).GET().json();
  const [first, second] = [await boot(), await boot()];
  expect(first.workspaceId).toBe('workspace-one'); expect(second.workspaceId).toBe('workspace-one');
  expect(first.generation).not.toBe(second.generation);
  const unwired = await (createApiRoutes({ config: structuredClone(DEFAULT_CONFIG), daemonStartedAt: Date.now(), healthMonitor: {} } as ApiContext)['/api/brief/host'] as { GET(): Response }).GET().json();
  expect(unwired.workspaceId).toBe(unwired.generation);
});

import { afterEach, describe, expect, it } from 'bun:test';
import { createApiRoutes, type ApiContext } from './api-routes.ts';
import { DEBUG_RPC_ENV, DEBUG_RPC_HEADER, initDebugRpcGate, MIN_SECRET_LENGTH } from './debug-rpc-gate.ts';
import type { JarvisConfig } from '../config/types.ts';
import type { SidecarInfo } from '../sidecar/types.ts';

/**
 * Tests for the `__list_sidecars` pseudo-method on POST /api/debug/rpc.
 *
 * bench/control/acceptance.ts discovers its target through this call and
 * nothing else, so whatever it needs to reason about a sidecar has to survive
 * the projection here. `os` is load-bearing: get_window_tree's `semantic` flag
 * is read only on Windows, and without the OS the harness cannot tell a
 * missing surface from a stale build and tells macOS/Linux operators to go and
 * rebuild something that will never satisfy the check.
 */

const SECRET = 'd'.repeat(MIN_SECRET_LENGTH);

const SIDECAR: SidecarInfo = {
  id: 'sid-1',
  name: 'macbook',
  enrolled_at: '2026-01-01T00:00:00Z',
  last_seen_at: '2026-01-01T00:00:00Z',
  status: 'enrolled',
  connected: true,
  hostname: 'macbook.local',
  os: 'darwin',
  platform: 'arm64',
  capabilities: ['desktop', 'browser'] as SidecarInfo['capabilities'],
  version: '0.1.0',
};

function listHandler() {
  initDebugRpcGate({ hosted: false }, { [DEBUG_RPC_ENV]: SECRET });
  const routes = createApiRoutes({
    daemonStartedAt: Date.now(),
    healthMonitor: {} as ApiContext['healthMonitor'],
    config: { llm: { providers: {} } } as JarvisConfig,
    sidecarManager: {
      listSidecars: () => [SIDECAR],
    } as unknown as ApiContext['sidecarManager'],
  } as ApiContext);
  const route = routes['/api/debug/rpc'] as { POST?: (req: Request) => Response | Promise<Response> };
  if (!route?.POST) throw new Error('Route /api/debug/rpc POST not registered');
  return route.POST;
}

const listRequest = (token = SECRET) =>
  new Request('http://localhost/api/debug/rpc', {
    method: 'POST',
    body: JSON.stringify({ method: '__list_sidecars' }),
    headers: { 'Content-Type': 'application/json', [DEBUG_RPC_HEADER]: token },
  });

describe('POST /api/debug/rpc __list_sidecars', () => {
  afterEach(() => {
    // Leave the gate shut for every other test in the process.
    initDebugRpcGate({ hosted: false }, {});
  });

  it('reports the sidecar OS, so the bench harness can tell a platform gap from a stale build', async () => {
    const res = await listHandler()(listRequest());
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.os).toBe('darwin');
  });

  it('still carries the fields the harness selects a target with', async () => {
    const res = await listHandler()(listRequest());
    const rows = (await res.json()) as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({
      id: 'sid-1',
      name: 'macbook',
      connected: true,
      capabilities: ['desktop', 'browser'],
    });
  });

  it('is still behind the gate: a wrong token gets a 404, not a sidecar list', async () => {
    const res = await listHandler()(listRequest('e'.repeat(MIN_SECRET_LENGTH)));
    expect(res.status).toBe(404);
  });
});

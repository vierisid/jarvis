import { describe, expect, it } from 'bun:test';
import { createApiRoutes, type ApiContext } from './api-routes.ts';
import type { JarvisConfig } from '../config/types.ts';

/**
 * PATCH /api/sidecars/:id/config forwards the body to the sidecar's
 * update_config RPC. A malformed body is a client error, not a 500, and must
 * never reach the sidecar.
 */

type Handler = (req: Request) => Response | Promise<Response>;

function setup() {
  const calls: Array<{ id: string; method: string; params: unknown }> = [];
  const routes = createApiRoutes({
    daemonStartedAt: Date.now(),
    healthMonitor: {} as ApiContext['healthMonitor'],
    config: { llm: { providers: {} } } as JarvisConfig,
    sidecarManager: {
      isConnected: () => true,
      dispatchRPC: async (id: string, method: string, params: unknown) => {
        calls.push({ id, method, params });
        return { ok: true };
      },
    } as unknown as ApiContext['sidecarManager'],
  } as ApiContext);
  const route = routes['/api/sidecars/:id/config'] as { PATCH?: Handler } | undefined;
  if (!route?.PATCH) throw new Error('Route /api/sidecars/:id/config PATCH not registered');
  return { patch: route.PATCH, calls };
}

const req = (body: string) =>
  new Request('http://localhost/api/sidecars/sc-1/config', { method: 'PATCH', body });

describe('PATCH /api/sidecars/:id/config', () => {
  for (const [name, body, message] of [
    ['invalid JSON', '{nope', 'Invalid JSON body'],
    ['null', 'null', 'Body must be a JSON object'],
    ['an array', '[]', 'Body must be a JSON object'],
    ['a string', '"x"', 'Body must be a JSON object'],
  ] as const) {
    it(`rejects ${name} with 400 without dispatching`, async () => {
      const { patch, calls } = setup();
      const res = await patch(req(body));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: message });
      expect(calls).toEqual([]);
    });
  }

  it('forwards an object body to update_config without the token', async () => {
    const { patch, calls } = setup();
    const res = await patch(req(JSON.stringify({ token: 't', awareness: { screen_interval_ms: 5000 } })));
    expect(res.status).toBe(200);
    expect(calls).toEqual([
      { id: 'sc-1', method: 'update_config', params: { awareness: { screen_interval_ms: 5000 } } },
    ]);
  });
});

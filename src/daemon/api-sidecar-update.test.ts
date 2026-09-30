import { describe, expect, it } from 'bun:test';
import { createApiRoutes, type ApiContext } from './api-routes.ts';
import type { JarvisConfig } from '../config/types.ts';
import { SidecarRPCError } from '../sidecar/rpc.ts';
import { SIDECAR_LATEST_VERSION } from '../sidecar/compat.ts';

/**
 * POST /api/sidecars/:id/update-prompt and /update: the dashboard's update
 * hint. Each forwards to the sidecar's self-update RPC only when the sidecar
 * is connected and advertises the matching feature, and passes the sidecar's
 * own refusal back as a 409 the dashboard can show.
 */

type Handler = (req: Request) => Response | Promise<Response>;

interface Stub {
  connected?: boolean;
  features?: string[];
  rpc?: (method: string, params: Record<string, unknown>) => Promise<unknown>;
}

function routesFor(stub: Stub) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const routes = createApiRoutes({
    daemonStartedAt: Date.now(),
    healthMonitor: {} as ApiContext['healthMonitor'],
    config: { llm: { providers: {} } } as JarvisConfig,
    sidecarManager: {
      isConnected: () => stub.connected ?? true,
      getSidecar: (id: string) => ({ id, features: stub.features ?? [] }),
      dispatchRPC: async (_id: string, method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        return stub.rpc ? stub.rpc(method, params) : { ok: true };
      },
    } as unknown as ApiContext['sidecarManager'],
  } as ApiContext);
  const post = (path: string) => {
    const route = routes[path] as { POST?: Handler } | undefined;
    if (!route?.POST) throw new Error(`Route ${path} POST not registered`);
    return route.POST;
  };
  return {
    prompt: () => post('/api/sidecars/:id/update-prompt')(new Request('http://localhost/api/sidecars/sid-1/update-prompt', { method: 'POST' })),
    apply: () => post('/api/sidecars/:id/update')(new Request('http://localhost/api/sidecars/sid-1/update', { method: 'POST' })),
    calls,
  };
}

describe('POST /api/sidecars/:id/update-prompt', () => {
  it('opens the native prompt on a sidecar that has one', async () => {
    const r = routesFor({ features: ['update_prompt', 'update_apply'] });
    const res = await r.prompt();
    expect(res.status).toBe(200);
    expect(r.calls).toEqual([{ method: 'sidecar.update_prompt', params: {} }]);
  });

  it('is 422 for a sidecar without the feature, and never reaches it', async () => {
    const r = routesFor({ features: ['update_apply'] });
    expect((await r.prompt()).status).toBe(422);
    expect(r.calls).toEqual([]);
  });

  it('is 409 for an offline sidecar', async () => {
    const r = routesFor({ connected: false, features: ['update_prompt'] });
    expect((await r.prompt()).status).toBe(409);
    expect(r.calls).toEqual([]);
  });
});

describe('POST /api/sidecars/:id/update', () => {
  it('asks the sidecar to install the version this brain ships with', async () => {
    const r = routesFor({ features: ['update_apply'] });
    const res = await r.apply();
    expect(res.status).toBe(200);
    expect(r.calls).toEqual([{ method: 'sidecar.update_apply', params: { version: SIDECAR_LATEST_VERSION } }]);
  });

  it('passes the sidecar refusal back as a 409', async () => {
    const r = routesFor({
      features: ['update_apply'],
      rpc: async () => { throw new SidecarRPCError('UPDATE_BUSY', 'an update is already in progress'); },
    });
    const res = await r.apply();
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain('already in progress');
  });

  it('is 422 for a sidecar that cannot update itself', async () => {
    const r = routesFor({ features: [] });
    expect((await r.apply()).status).toBe(422);
    expect(r.calls).toEqual([]);
  });
});

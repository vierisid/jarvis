import { describe, expect, it } from 'bun:test';
import { createApiRoutes, type ApiContext } from './api-routes.ts';
import type { JarvisConfig } from '../config/types.ts';

/**
 * Tests for GET /api/llm/budget.
 *
 * Two things matter here and they are the same two the sibling catalog route
 * guards: (1) availability — a self-hosted install has no key, no plan and no
 * windows, so 503 is the honest answer rather than a meter of zeros; and (2)
 * secrecy — no path may echo the control-plane host or the usage secret back to
 * the client, which is a browser-reachable surface.
 */

type Handler = (req: Request) => Response | Promise<Response>;

function handlerFor(config: Partial<JarvisConfig>): Handler {
  const routes = createApiRoutes({
    daemonStartedAt: Date.now(),
    healthMonitor: {} as ApiContext['healthMonitor'],
    config: { llm: { providers: {} }, ...config } as JarvisConfig,
  } as ApiContext);
  const route = routes['/api/llm/budget'] as { GET?: Handler } | undefined;
  if (!route?.GET) throw new Error('Route /api/llm/budget GET not registered');
  return route.GET;
}

const SECRET = 'c'.repeat(64);

describe('GET /api/llm/budget', () => {
  it('is 503 on a self-hosted install', async () => {
    // No hosted block at all: there is no window to report on, and answering
    // with zeros would invent a budget this install does not have.
    const res = await handlerFor({})(new Request('http://localhost/api/llm/budget'));
    expect(res.status).toBe(503);
  });

  it('is 503 when the hosted block is incomplete', async () => {
    // hasUsejarvisAi requires BOTH base_url and api_key; half a block is not a
    // hosted install.
    const res = await handlerFor({
      usejarvis_ai: { base_url: 'https://llm.example/v1' },
    } as Partial<JarvisConfig>)(new Request('http://localhost/api/llm/budget'));
    expect(res.status).toBe(503);
  });

  it('reports UNAVAILABLE — not an error, and not a fake meter — when the usage fields are absent', async () => {
    // A hosted install whose control plane has no reachable origin renders the
    // block without the usage triple. That is a normal state: the meter simply
    // cannot be read, and the surface says so.
    const res = await handlerFor({
      usejarvis_ai: { base_url: 'https://llm.example/v1', api_key: 'sk-uj-x' },
    } as Partial<JarvisConfig>)(new Request('http://localhost/api/llm/budget'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, error: 'Usage is unavailable right now' });
  });

  it('never echoes the control-plane host or the usage secret when the read fails', async () => {
    // This body reaches a browser. The catalog route next door exists partly
    // because an upstream error page leaked a hostname the settings surface
    // deliberately hides; the same rule applies here.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error('connect ECONNREFUSED https://control-plane.internal');
    }) as unknown as typeof fetch;
    try {
      const res = await handlerFor({
        usejarvis_ai: {
          base_url: 'https://llm.example/v1',
          api_key: 'sk-uj-x',
          usage_url: 'https://control-plane.internal/api/llm/instance-usage',
          instance_id: 'inst-1',
          usage_secret: SECRET,
        },
      } as Partial<JarvisConfig>)(new Request('http://localhost/api/llm/budget'));
      const text = await res.text();
      expect(text).not.toContain('control-plane.internal');
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain('inst-1');
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

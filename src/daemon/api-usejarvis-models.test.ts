import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { createApiRoutes, type ApiContext } from './api-routes.ts';
import type { JarvisConfig } from '../config/types.ts';

/**
 * Tests for GET /api/config/llm/usejarvis/models.
 *
 * The interesting parts of this handler are (1) availability: the catalog
 * exists only on hosted installs (a complete system-owned usejarvis_ai
 * block), 503 otherwise; and (2) secrecy: the block's key travels ONLY to
 * the block's own base_url, and no error path may echo the base_url host or
 * key material back to the client — the settings surface deliberately hides
 * both, and an upstream CDN error page would otherwise leak them through
 * the provider's rewritten error messages. We stub global fetch and assert
 * on the exact outgoing request and on the response body's contents.
 */

const HOSTED_BASE = 'https://llm.usejarvis.host';
const HOSTED_KEY = 'sk-uj-abc123';

type Handler = (req: Request) => Response | Promise<Response>;
type MethodHandlers = { GET?: Handler; POST?: Handler };

function getHandler(routes: Record<string, unknown>, path: string, method: 'GET' | 'POST'): Handler {
  const route = routes[path] as MethodHandlers | undefined;
  if (!route) throw new Error(`Route ${path} not registered`);
  const handler = route[method];
  if (!handler) throw new Error(`Method ${method} not registered for ${path}`);
  return handler;
}

function makeCtx(usejarvisAi?: { base_url?: string; api_key?: string }): ApiContext {
  return {
    daemonStartedAt: Date.now(),
    healthMonitor: {} as ApiContext['healthMonitor'],
    config: { llm: { providers: {} }, ...(usejarvisAi ? { usejarvis_ai: usejarvisAi } : {}) } as JarvisConfig,
  } as ApiContext;
}

function callEndpoint(usejarvisAi?: { base_url?: string; api_key?: string }) {
  const routes = createApiRoutes(makeCtx(usejarvisAi));
  const handler = getHandler(routes, '/api/config/llm/usejarvis/models', 'GET');
  return handler(new Request('http://x/api/config/llm/usejarvis/models'));
}

describe('GET /api/config/llm/usejarvis/models', () => {
  const realFetch = globalThis.fetch;
  let upstream: { url: string; auth: string | undefined } | null;
  let upstreamResponse: () => Response;

  beforeEach(() => {
    upstream = null;
    upstreamResponse = () =>
      new Response(JSON.stringify({ data: [{ id: 'uj-high' }, { id: 'uj-chat' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      upstream = { url: String(input), auth: headers.get('Authorization') ?? undefined };
      return upstreamResponse();
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('answers 503 on self-hosted installs (block absent or incomplete) without probing anything', async () => {
    for (const block of [undefined, { base_url: HOSTED_BASE }, { api_key: HOSTED_KEY }]) {
      const res = await callEndpoint(block);
      expect(res.status).toBe(503);
      const body = await res.json() as { error: string };
      expect(body.error).toBe('Usejarvis AI is only available on hosted installs.');
      expect(upstream).toBeNull();
    }
  });

  it('returns the key-scoped catalog, sending the block key ONLY to the block base_url', async () => {
    const res = await callEndpoint({ base_url: HOSTED_BASE, api_key: HOSTED_KEY });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; models: string[]; degraded: boolean };
    expect(body.ok).toBe(true);
    expect(body.models).toEqual(['uj-chat', 'uj-high']); // provider sorts + dedupes
    expect(body.degraded).toBe(false);
    expect(upstream!.url).toBe(`${HOSTED_BASE}/v1/models`);
    expect(upstream!.auth).toBe(`Bearer ${HOSTED_KEY}`);
  });

  it('degrades upstream failures to the fallback aliases, leaking neither the key nor the host', async () => {
    // A CDN fronting the proxy answers with an HTML error page that names
    // the origin host — exactly what the response body must not echo. The
    // provider degrades to the core aliases so the tier picker keeps working.
    upstreamResponse = () =>
      new Response(`<html>origin ${HOSTED_BASE} unreachable</html>`, { status: 502 });
    const res = await callEndpoint({ base_url: HOSTED_BASE, api_key: HOSTED_KEY });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; models: string[]; degraded: boolean };
    expect(body.ok).toBe(true);
    expect(body.models).toEqual(['uj-chat', 'uj-high', 'uj-low', 'uj-medium']);
    expect(body.degraded).toBe(true);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('llm.usejarvis.host');
    expect(serialized).not.toContain(HOSTED_KEY);
  });
});

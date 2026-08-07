import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { createApiRoutes, type ApiContext } from './api-routes.ts';
import type { JarvisConfig, LLMProviderEntry } from '../config/types.ts';

/**
 * Tests for POST /api/config/llm/omniroute/models.
 *
 * The interesting part of this handler is credential/URL resolution: which
 * base URL the catalog probe hits and - critically - when the stored API key
 * is allowed to travel with it. A caller-typed base_url must never receive
 * saved credentials, otherwise any caller who can reach the daemon can point
 * the probe at their own host and harvest the key from the Authorization
 * header. We stub global fetch and assert on the exact outgoing request.
 */

type Handler = (req: Request) => Response | Promise<Response>;
type MethodHandlers = { GET?: Handler; POST?: Handler };

function getHandler(routes: Record<string, unknown>, path: string, method: 'GET' | 'POST'): Handler {
  const route = routes[path] as MethodHandlers | undefined;
  if (!route) throw new Error(`Route ${path} not registered`);
  const handler = route[method];
  if (!handler) throw new Error(`Method ${method} not registered for ${path}`);
  return handler;
}

function makeCtx(providers: Record<string, LLMProviderEntry>): ApiContext {
  return {
    daemonStartedAt: Date.now(),
    healthMonitor: {} as ApiContext['healthMonitor'],
    config: { llm: { providers } } as JarvisConfig,
  } as ApiContext;
}

function callEndpoint(providers: Record<string, LLMProviderEntry>, body: Record<string, unknown>) {
  const routes = createApiRoutes(makeCtx(providers));
  const handler = getHandler(routes, '/api/config/llm/omniroute/models', 'POST');
  return handler(new Request('http://x/api/config/llm/omniroute/models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

describe('POST /api/config/llm/omniroute/models', () => {
  const realFetch = globalThis.fetch;
  let upstream: { url: string; auth: string | undefined } | null;

  beforeEach(() => {
    upstream = null;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      upstream = { url: String(input), auth: headers.get('Authorization') ?? undefined };
      return new Response(JSON.stringify({ data: [{ id: 'auto' }, { id: 'free/gemini' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('never attaches the stored key to a caller-supplied base_url', async () => {
    const res = await callEndpoint(
      { 'omni-gw': { kind: 'omniroute', base_url: 'http://saved.example/v1', api_key: 'stored-secret' } },
      { name: 'omni-gw', base_url: 'http://caller.example/v1' },
    );
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(upstream!.url.startsWith('http://caller.example/v1')).toBe(true);
    expect(upstream!.auth).toBeUndefined();
  });

  it('uses the stored key when the base URL also comes from stored config', async () => {
    const res = await callEndpoint(
      { 'omni-gw': { kind: 'omniroute', base_url: 'http://saved.example/v1', api_key: 'stored-secret' } },
      { name: 'omni-gw' },
    );
    const body = await res.json() as { ok: boolean; models: string[] };
    expect(body.ok).toBe(true);
    expect(body.models).toEqual(['auto', 'free/gemini']);
    expect(upstream!.url.startsWith('http://saved.example/v1')).toBe(true);
    expect(upstream!.auth).toBe('Bearer stored-secret');
  });

  it('sends a caller-supplied key with a caller-supplied base_url', async () => {
    const res = await callEndpoint(
      {},
      { base_url: 'http://caller.example/v1', api_key: 'typed-key' },
    );
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(upstream!.auth).toBe('Bearer typed-key');
  });

  it('resolves kind as `entry.kind ?? name` like the rest of the system', async () => {
    // A provider simply named "omniroute" with no explicit kind field.
    const res = await callEndpoint(
      { omniroute: { base_url: 'http://saved.example/v1' } },
      { name: 'omniroute' },
    );
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(upstream!.url.startsWith('http://saved.example/v1')).toBe(true);
  });

  it('discovers a kind-defaulted provider when no name is given', async () => {
    const res = await callEndpoint(
      { omniroute: { base_url: 'http://saved.example/v1' } },
      {},
    );
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(upstream!.url.startsWith('http://saved.example/v1')).toBe(true);
  });

  it('rejects a name that is not an OmniRoute provider', async () => {
    const res = await callEndpoint(
      { anthropic: { kind: 'anthropic', api_key: 'sk-x' } },
      { name: 'anthropic' },
    );
    const body = await res.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe('OmniRoute provider not found');
    expect(upstream).toBeNull();
  });

  it('rejects an unknown provider name', async () => {
    const res = await callEndpoint({}, { name: 'nope' });
    const body = await res.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe('OmniRoute provider not found');
    expect(upstream).toBeNull();
  });

  it('rejects a non-http(s) base_url', async () => {
    const res = await callEndpoint({}, { base_url: 'file:///etc/passwd' });
    const body = await res.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe('base_url must be an http(s) URL');
    expect(upstream).toBeNull();
  });

  it('falls back to the default local URL with no key when nothing is configured', async () => {
    const res = await callEndpoint({}, {});
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(upstream!.url.startsWith('http://localhost:20128/v1')).toBe(true);
    expect(upstream!.auth).toBeUndefined();
  });
});

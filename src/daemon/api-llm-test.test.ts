import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createApiRoutes, type ApiContext } from './api-routes.ts';
import { saveLLMSettings } from './llm-settings.ts';
import type { JarvisConfig, LLMProviderEntry } from '../config/types.ts';

type Handler = (req: Request) => Response | Promise<Response>;
type CapturedRequest = {
  url: string;
  authorization: string | null;
  apiKey: string | null;
  model?: string;
};

function callEndpoint(
  providers: Record<string, LLMProviderEntry>,
  body: Record<string, unknown>,
): Response | Promise<Response> {
  const ctx = {
    daemonStartedAt: Date.now(),
    healthMonitor: {} as ApiContext['healthMonitor'],
    config: { llm: { providers } } as JarvisConfig,
  } as ApiContext;
  const route = createApiRoutes(ctx)['/api/config/llm/test'] as { POST: Handler };
  return route.POST(new Request('http://x/api/config/llm/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

describe('POST /api/config/llm/test Anthropic endpoint scoping', () => {
  const realFetch = globalThis.fetch;
  let requests: CapturedRequest[];

  beforeEach(() => {
    requests = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const requestBody = init?.body ? JSON.parse(String(init.body)) as { model?: string } : {};
      const url = String(input);
      requests.push({
        url,
        authorization: headers.get('authorization'),
        apiKey: headers.get('x-api-key'),
        model: requestBody.model,
      });
      if (url.endsWith('/v1/models')) {
        return new Response(JSON.stringify({
          data: [{ id: 'gateway-fast' }, { id: 'gateway-large' }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'OK' }],
        model: requestBody.model ?? 'claude-default',
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('never sends a stored token to a caller-supplied URL', async () => {
    const response = await callEndpoint(
      { 'anthropic-sec-test': { kind: 'anthropic', api_key: 'stored-secret' } },
      { name: 'anthropic-sec-test', base_url: 'https://attacker.example' },
    );
    const body = await response.json() as { ok: boolean; error: string };

    expect(body.ok).toBe(false);
    expect(body.error).toContain('requires an explicit api_key');
    expect(requests).toHaveLength(0);
  });

  it('uses the stored token with its unchanged stored endpoint', async () => {
    const response = await callEndpoint(
      { 'anthropic-sec-test': { kind: 'anthropic', api_key: 'stored-secret', base_url: 'https://saved.example' } },
      { name: 'anthropic-sec-test' },
    );
    const body = await response.json() as { ok: boolean; model: string; models: string[] };

    expect(body.ok).toBe(true);
    expect(body.model).toBe('gateway-fast');
    expect(body.models).toEqual(['gateway-fast', 'gateway-large']);
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.url.startsWith('https://saved.example/'))).toBe(true);
    expect(requests.every((request) => request.authorization === 'Bearer stored-secret')).toBe(true);
  });

  it('tries the next discovered model when the key cannot use the first one', async () => {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const requestBody = init?.body ? JSON.parse(String(init.body)) as { model?: string } : {};
      requests.push({
        url,
        authorization: new Headers(init?.headers).get('authorization'),
        apiKey: null,
        model: requestBody.model,
      });
      if (url.endsWith('/v1/models')) {
        return new Response(JSON.stringify({
          data: [{ id: 'premium-denied' }, { id: 'allowed-model' }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (requestBody.model === 'premium-denied') {
        return new Response(JSON.stringify({
          error: { type: 'authentication_error', message: 'Model "premium-denied" not allowed for this key' },
        }), { status: 403, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        id: 'msg_test', type: 'message', role: 'assistant',
        content: [{ type: 'text', text: 'OK' }], model: requestBody.model,
        stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;

    const response = await callEndpoint(
      { 'anthropic-sec-test': { kind: 'anthropic', api_key: 'stored-secret', base_url: 'https://saved.example' } },
      { name: 'anthropic-sec-test' },
    );
    const body = await response.json() as { ok: boolean; model: string; models: string[] };

    expect(body.ok).toBe(true);
    expect(body.model).toBe('allowed-model');
    expect(body.models).toEqual(['premium-denied', 'allowed-model']);
    expect(requests.map((request) => request.model).filter(Boolean))
      .toEqual(['premium-denied', 'allowed-model']);
  });

  it('uses only an explicitly supplied token at a changed endpoint', async () => {
    const response = await callEndpoint(
      { 'anthropic-sec-test': { kind: 'anthropic', api_key: 'stored-secret', base_url: 'https://saved.example' } },
      { name: 'anthropic-sec-test', base_url: 'https://new.example', api_key: 'fresh-token' },
    );
    const body = await response.json() as { ok: boolean };

    expect(body.ok).toBe(true);
    expect(requests.every((request) => request.url.startsWith('https://new.example/'))).toBe(true);
    expect(requests.every((request) => request.authorization === 'Bearer fresh-token')).toBe(true);
  });

  it('refuses to replay the stored gateway token against the official endpoint', async () => {
    const response = await callEndpoint(
      { 'anthropic-sec-test': { kind: 'anthropic', api_key: 'stored-secret', base_url: 'https://saved.example' } },
      { name: 'anthropic-sec-test', base_url: '' },
    );
    const body = await response.json() as { ok: boolean; error: string };

    expect(body.ok).toBe(false);
    expect(body.error).toContain('requires an explicit api_key');
    expect(requests).toHaveLength(0);
  });

  it('refuses to replay the stored token against another provider kind', async () => {
    const response = await callEndpoint(
      { 'anthropic-sec-test': { kind: 'anthropic', api_key: 'stored-secret' } },
      { name: 'anthropic-sec-test', kind: 'omniroute' },
    );
    const body = await response.json() as { ok: boolean; error: string };

    expect(body.ok).toBe(false);
    expect(body.error).toContain('requires an explicit api_key');
    expect(requests).toHaveLength(0);
  });

  it('accepts the stored token when the kind is restated unchanged', async () => {
    const response = await callEndpoint(
      { 'anthropic-sec-test': { kind: 'anthropic', api_key: 'stored-secret', base_url: 'https://saved.example' } },
      { name: 'anthropic-sec-test', kind: 'anthropic' },
    );
    const body = await response.json() as { ok: boolean };

    expect(body.ok).toBe(true);
    expect(requests.every((request) => request.url.startsWith('https://saved.example/'))).toBe(true);
  });

  it('tests the official endpoint after the URL is cleared and a fresh key is supplied', async () => {
    const response = await callEndpoint(
      { 'anthropic-sec-test': { kind: 'anthropic', api_key: 'stored-secret', base_url: 'https://saved.example' } },
      { name: 'anthropic-sec-test', base_url: '', api_key: 'fresh-key' },
    );
    const body = await response.json() as { ok: boolean; models?: string[] };

    expect(body.ok).toBe(true);
    expect(body.models).toBeUndefined();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe('https://api.anthropic.com/v1/messages');
    expect(requests[0]!.apiKey).toBe('fresh-key');
    expect(requests[0]!.authorization).toBeNull();
  });

  it('does not label curated fallback models as gateway discovery', async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      requests.push({ url: String(input), authorization: null, apiKey: null });
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;

    const response = await callEndpoint(
      { 'anthropic-sec-test': { kind: 'anthropic', api_key: 'stored-secret', base_url: 'https://saved.example' } },
      { name: 'anthropic-sec-test' },
    );
    const body = await response.json() as { ok: boolean; error: string; models?: string[] };

    expect(body.ok).toBe(false);
    expect(body.error).toContain('Could not discover any models');
    expect(body.models).toBeUndefined();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe('https://saved.example/v1/models');
  });

  it('also rejects persisting a new endpoint while retaining the stored token', () => {
    const config = {
      llm: {
        providers: {
          'anthropic-sec-test': { kind: 'anthropic', api_key: 'stored-secret' },
        },
        tiers: {},
      },
    } as unknown as JarvisConfig;

    expect(() => saveLLMSettings(config, {
      providers: {
        'anthropic-sec-test': { base_url: 'https://attacker.example' },
      },
    })).toThrow('requires the API key or auth token again');
  });

  it('also rejects clearing the gateway URL while retaining the stored token', () => {
    const config = {
      llm: {
        providers: {
          'anthropic-sec-test': { kind: 'anthropic', api_key: 'stored-secret', base_url: 'https://saved.example' },
        },
        tiers: {},
      },
    } as unknown as JarvisConfig;

    expect(() => saveLLMSettings(config, {
      providers: {
        'anthropic-sec-test': { base_url: '' },
      },
    })).toThrow('requires the API key or auth token again');
  });

  it('also rejects switching the provider kind while retaining the stored token', () => {
    const config = {
      llm: {
        providers: {
          'anthropic-sec-test': { kind: 'anthropic', api_key: 'stored-secret' },
        },
        tiers: {},
      },
    } as unknown as JarvisConfig;

    expect(() => saveLLMSettings(config, {
      providers: {
        'anthropic-sec-test': { kind: 'openai' },
      },
    })).toThrow('requires the API key or auth token again');
  });

  it('validates every provider update before applying any of them', () => {
    const config = {
      llm: {
        providers: {
          'anthropic-sec-test': { kind: 'anthropic', api_key: 'stored-secret' },
        },
        tiers: {},
      },
    } as unknown as JarvisConfig;

    expect(() => saveLLMSettings(config, {
      providers: {
        innocent: { kind: 'anthropic', base_url: 'https://ok.example', api_key: 'fresh-key' },
        'anthropic-sec-test': { base_url: 'https://attacker.example' },
      },
    })).toThrow('requires the API key or auth token again');
    // The valid entry listed before the rejected one must not have been
    // applied to the in-memory config.
    expect(config.llm.providers?.['innocent']).toBeUndefined();
  });
});

describe('POST /api/config/llm/test OpenAI-compatible discovery', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => { globalThis.fetch = realFetch; });

  it('normalizes the API root, discovers a model, and tests chat with it', async () => {
    const requests: Array<{ url: string; model?: string }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const requestBody = init?.body ? JSON.parse(String(init.body)) as { model?: string } : {};
      requests.push({ url, model: requestBody.model });
      if (url.endsWith('/models')) {
        return Response.json({ data: [{ id: 'custom-chat' }, { id: 'another-model' }] });
      }
      return Response.json({
        id: 'chat_test', object: 'chat.completion', created: 1, model: requestBody.model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    }) as unknown as typeof fetch;

    const response = await callEndpoint(
      { compatible: { kind: 'openai_compatible', api_key: 'stored-secret', base_url: 'https://gateway.example/api' } },
      { name: 'compatible' },
    );
    const body = await response.json() as { ok: boolean; model: string; models: string[] };

    expect(body).toEqual({ ok: true, model: 'custom-chat', models: ['custom-chat', 'another-model'] });
    expect(requests).toEqual([
      { url: 'https://gateway.example/api/v1/models', model: undefined },
      { url: 'https://gateway.example/api/v1/chat/completions', model: 'custom-chat' },
    ]);
  });
});

/**
 * The settings tab sends the auth-header selection along with a connection
 * test. These pin the daemon end of that seam: the header must only be
 * applied when the caller actually chose one, because overriding a provider's
 * own default silently breaks authentication against the official endpoint.
 */
describe('POST /api/config/llm/test auth header selection', () => {
  const realFetch = globalThis.fetch;
  let requests: CapturedRequest[];

  beforeEach(() => {
    requests = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const requestBody = init?.body ? JSON.parse(String(init.body)) as { model?: string } : {};
      const url = String(input);
      requests.push({
        url,
        authorization: headers.get('authorization'),
        apiKey: headers.get('x-api-key'),
        model: requestBody.model,
      });
      if (url.endsWith('/v1/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'gateway-fast' }] }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'OK' }],
        model: requestBody.model ?? 'claude-default',
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('keeps x-api-key on the official Anthropic endpoint when no header is chosen', async () => {
    const response = await callEndpoint(
      { 'anthropic-hdr-test': { kind: 'anthropic', api_key: 'sk-ant-stored' } },
      { name: 'anthropic-hdr-test' },
    );
    const body = await response.json() as { ok: boolean };

    expect(body.ok).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests.every((r) => r.apiKey === 'sk-ant-stored')).toBe(true);
    expect(requests.every((r) => r.authorization === null)).toBe(true);
  });

  it('still auto-selects Bearer for a custom Anthropic endpoint', async () => {
    const response = await callEndpoint(
      { 'gw-hdr-test': { kind: 'anthropic', api_key: 'gw-key', base_url: 'https://gw.example' } },
      { name: 'gw-hdr-test' },
    );
    const body = await response.json() as { ok: boolean };

    expect(body.ok).toBe(true);
    expect(requests.every((r) => r.authorization === 'Bearer gw-key')).toBe(true);
    expect(requests.every((r) => r.apiKey === null)).toBe(true);
  });

  it('honors an explicitly chosen x-api-key on a custom endpoint', async () => {
    const response = await callEndpoint(
      { 'gw-hdr-test': { kind: 'anthropic', api_key: 'gw-key', base_url: 'https://gw.example' } },
      { name: 'gw-hdr-test', auth_header: 'x-api-key' },
    );
    const body = await response.json() as { ok: boolean };

    expect(body.ok).toBe(true);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((r) => r.apiKey === 'gw-key')).toBe(true);
    expect(requests.every((r) => r.authorization === null)).toBe(true);
  });

  it('falls back to the stored header when the request omits one', async () => {
    const response = await callEndpoint(
      { 'gw-hdr-test': { kind: 'anthropic', api_key: 'gw-key', base_url: 'https://gw.example', auth_header: 'x-api-key' } },
      { name: 'gw-hdr-test' },
    );
    const body = await response.json() as { ok: boolean };

    expect(body.ok).toBe(true);
    expect(requests.every((r) => r.apiKey === 'gw-key')).toBe(true);
    expect(requests.every((r) => r.authorization === null)).toBe(true);
  });

  it('rejects an illegal header name with the same message the save path uses', async () => {
    const response = await callEndpoint(
      { 'gw-hdr-test': { kind: 'anthropic', api_key: 'gw-key', base_url: 'https://gw.example' } },
      { name: 'gw-hdr-test', auth_header: 'bad header\r\nX-Evil: 1' },
    );
    const body = await response.json() as { ok: boolean; error: string };

    expect(body.ok).toBe(false);
    expect(body.error).toContain('invalid auth header name');
    expect(requests).toHaveLength(0);
  });
});

/**
 * A connection test probes catalog models until one answers. Each probe is a
 * real billable request, so the walk is capped — gateways fronting many
 * upstreams routinely advertise catalogs in the hundreds.
 */
describe('POST /api/config/llm/test model probing is bounded', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  function gatewayRejectingEveryModel(catalogSize: number) {
    const counts = { chat: 0 };
    const catalog = Array.from({ length: catalogSize }, (_, i) => ({ id: `model-${i}` }));
    globalThis.fetch = (async (input: string | URL | Request) => {
      if (String(input).endsWith('/models')) return Response.json({ data: catalog });
      counts.chat++;
      return Response.json({ error: { message: 'model not allowed for this key' } }, { status: 403 });
    }) as unknown as typeof fetch;
    return counts;
  }

  it('caps the custom-Anthropic walk instead of probing the whole catalog', async () => {
    const counts = gatewayRejectingEveryModel(60);
    const response = await callEndpoint(
      { 'gw-probe-anthropic': { kind: 'anthropic', api_key: 'k', base_url: 'https://gw.example' } },
      { name: 'gw-probe-anthropic' },
    );
    const body = await response.json() as { ok: boolean; error: string };

    expect(body.ok).toBe(false);
    expect(counts.chat).toBe(10);
    expect(body.error).toContain('could not use any of the 10 tried');
  });

  it('caps the OpenAI-compatible walk the same way', async () => {
    const counts = gatewayRejectingEveryModel(60);
    const response = await callEndpoint(
      { 'gw-probe-compat': { kind: 'openai_compatible', api_key: 'k', base_url: 'https://gw.example/v1' } },
      { name: 'gw-probe-compat' },
    );
    const body = await response.json() as { ok: boolean };

    expect(body.ok).toBe(false);
    expect(counts.chat).toBe(10);
  });

  it('stops at the first model when the credential itself is rejected', async () => {
    let chat = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      if (String(input).endsWith('/models')) {
        return Response.json({ data: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] });
      }
      chat++;
      return Response.json({ error: { message: 'invalid api key' } }, { status: 401 });
    }) as unknown as typeof fetch;

    const response = await callEndpoint(
      { 'gw-probe-auth': { kind: 'openai_compatible', api_key: 'bad', base_url: 'https://gw.example/v1' } },
      { name: 'gw-probe-auth' },
    );
    const body = await response.json() as { ok: boolean; error: string };

    expect(body.ok).toBe(false);
    expect(chat).toBe(1);
    expect(body.error).toContain('401');
  });

  it('accepts an underscored model rejection and moves to the next model', async () => {
    let chat = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      if (String(input).endsWith('/models')) {
        return Response.json({ data: [{ id: 'locked' }, { id: 'usable' }] });
      }
      chat++;
      if (chat === 1) {
        return Response.json({ error: { message: 'model_not_found: locked' } }, { status: 404 });
      }
      return Response.json({
        id: 'c', object: 'chat.completion', created: 1, model: 'usable',
        choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    }) as unknown as typeof fetch;

    const response = await callEndpoint(
      { 'gw-probe-word': { kind: 'openai_compatible', api_key: 'k', base_url: 'https://gw.example/v1' } },
      { name: 'gw-probe-word' },
    );
    const body = await response.json() as { ok: boolean; model: string };

    expect(body.ok).toBe(true);
    expect(body.model).toBe('usable');
  });
});

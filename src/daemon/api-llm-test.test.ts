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

    expect(body).toEqual({ ok: true, model: 'another-model', models: ['another-model', 'custom-chat'] });
    expect(requests).toEqual([
      { url: 'https://gateway.example/api/v1/models', model: undefined },
      { url: 'https://gateway.example/api/v1/chat/completions', model: 'another-model' },
    ]);
  });
});

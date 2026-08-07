import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createApiRoutes, type ApiContext } from './api-routes.ts';
import type { JarvisConfig, LLMProviderEntry } from '../config/types.ts';

type Handler = (req: Request) => Response | Promise<Response>;

function callEndpoint(
  providers: Record<string, LLMProviderEntry>,
  body: Record<string, unknown>,
): Response | Promise<Response> {
  const ctx = {
    daemonStartedAt: Date.now(),
    healthMonitor: {} as ApiContext['healthMonitor'],
    config: { llm: { providers } } as JarvisConfig,
  } as ApiContext;
  const route = createApiRoutes(ctx)['/api/config/llm/groq/models'] as { POST: Handler };
  return route.POST(new Request('http://x/api/config/llm/groq/models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

describe('POST /api/config/llm/groq/models', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      data: [
        { id: 'openai/gpt-oss-20b' },
        { id: 'whisper-large-v3' },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('accepts a legacy synthesized provider whose kind defaults to its name', async () => {
    const response = await callEndpoint(
      { groq: {} },
      { name: 'groq', api_key: 'typed-key' },
    );
    const body = await response.json() as { ok: boolean; models: string[] };
    expect(body.ok).toBe(true);
    expect(body.models).toEqual(['openai/gpt-oss-20b']);
  });

  it('discovers a kind-defaulted provider when no name is supplied', async () => {
    const response = await callEndpoint(
      { groq: {} },
      { api_key: 'typed-key' },
    );
    const body = await response.json() as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it('rejects a configured provider of another kind', async () => {
    const response = await callEndpoint(
      { custom: { kind: 'openai' } },
      { name: 'custom', api_key: 'typed-key' },
    );
    const body = await response.json() as { ok: boolean; error: string; models: string[] };
    expect(body).toEqual({ ok: false, error: 'Groq provider not found', models: [] });
  });
});

import { describe, expect, it, afterEach } from 'bun:test';
import { OpenAIProvider } from './openai.ts';

const originalFetch = globalThis.fetch;

function mockFetchResponse(payload: unknown): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch;
}

function completionPayload(usage: Record<string, unknown>) {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 0,
    model: 'gpt-4o',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'hello' },
        finish_reason: 'stop',
      },
    ],
    usage,
  };
}

describe('OpenAIProvider HTTP failures', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const errorResponse = (status: number, headers: Record<string, string> = {}) =>
    new Response('{"error":{"message":"nope"}}', {
      status,
      headers: { 'Content-Type': 'application/json', ...headers },
    });

  it('chat throws a typed error carrying a numeric Retry-After', async () => {
    globalThis.fetch = (async () => errorResponse(429, { 'Retry-After': '7' })) as unknown as typeof fetch;
    await expect(new OpenAIProvider('k').chat([{ role: 'user', content: 'hi' }])).rejects.toMatchObject({
      name: 'LLMProviderError',
      code: 'rate_limit',
      retryAfterMs: 7_000,
    });
  });

  it('chat reads an HTTP-date Retry-After, and no header means no hint', async () => {
    const at = new Date(Date.now() + 30_000).toUTCString();
    globalThis.fetch = (async () => errorResponse(503, { 'Retry-After': at })) as unknown as typeof fetch;
    const dated = await new OpenAIProvider('k').chat([{ role: 'user', content: 'hi' }]).catch((e) => e);
    expect(dated.code).toBe('network');
    expect(dated.retryAfterMs).toBeGreaterThan(25_000);
    expect(dated.retryAfterMs).toBeLessThanOrEqual(30_000);

    globalThis.fetch = (async () => errorResponse(429)) as unknown as typeof fetch;
    const bare = await new OpenAIProvider('k').chat([{ role: 'user', content: 'hi' }]).catch((e) => e);
    expect(bare.retryAfterMs).toBeUndefined();
  });

  it('stream error events carry retry_after_ms only when the server sent one', async () => {
    const firstError = async () => {
      for await (const event of new OpenAIProvider('k').stream([{ role: 'user', content: 'hi' }])) {
        if (event.type === 'error') return event;
      }
      return null;
    };
    globalThis.fetch = (async () => errorResponse(429, { 'Retry-After': '60' })) as unknown as typeof fetch;
    expect(await firstError()).toMatchObject({ code: 'rate_limit', retry_after_ms: 60_000 });
    globalThis.fetch = (async () => errorResponse(429)) as unknown as typeof fetch;
    expect(await firstError()).not.toHaveProperty('retry_after_ms');
  });

  it('forwards the caller signal to fetch', async () => {
    let received: AbortSignal | null | undefined;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      received = init?.signal;
      return new Response(JSON.stringify(completionPayload({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 })), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const controller = new AbortController();
    await new OpenAIProvider('k').chat([{ role: 'user', content: 'hi' }], { signal: controller.signal });
    expect(received).toBe(controller.signal);
  });
});

describe('OpenAIProvider usage parsing', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('maps prompt_tokens_details.cached_tokens to cache_read_input_tokens', async () => {
    mockFetchResponse(completionPayload({
      prompt_tokens: 1200,
      completion_tokens: 40,
      total_tokens: 1240,
      prompt_tokens_details: { cached_tokens: 1024 },
    }));

    const provider = new OpenAIProvider('test-key');
    const response = await provider.chat([{ role: 'user', content: 'hi' }]);

    // Normalized: input_tokens excludes cached tokens (OpenAI's prompt_tokens
    // includes them), so input + cache_read = the full 1200-token prompt.
    expect(response.usage.input_tokens).toBe(1200 - 1024);
    expect(response.usage.output_tokens).toBe(40);
    expect(response.usage.cache_read_input_tokens).toBe(1024);
    expect(response.usage.cache_creation_input_tokens).toBeUndefined();
  });

  it('omits cache fields when prompt_tokens_details is absent', async () => {
    mockFetchResponse(completionPayload({
      prompt_tokens: 100,
      completion_tokens: 10,
      total_tokens: 110,
    }));

    const provider = new OpenAIProvider('test-key');
    const response = await provider.chat([{ role: 'user', content: 'hi' }]);

    expect(response.usage.input_tokens).toBe(100);
    expect(response.usage.cache_read_input_tokens).toBeUndefined();
    expect(response.usage.cache_creation_input_tokens).toBeUndefined();
  });
});

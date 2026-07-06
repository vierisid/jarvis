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

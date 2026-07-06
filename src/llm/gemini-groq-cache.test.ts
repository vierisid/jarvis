import { describe, expect, it, afterEach } from 'bun:test';
import { GeminiProvider } from './gemini.ts';
import { GroqProvider } from './groq.ts';

const originalFetch = globalThis.fetch;

function mockFetchResponse(payload: unknown): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch;
}

describe('GeminiProvider implicit-cache usage parsing', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('maps cachedContentTokenCount and normalizes input_tokens', async () => {
    mockFetchResponse({
      candidates: [{ content: { parts: [{ text: 'hello' }], role: 'model' }, finishReason: 'STOP' }],
      usageMetadata: {
        promptTokenCount: 3000,          // includes cached content
        candidatesTokenCount: 20,
        totalTokenCount: 3020,
        cachedContentTokenCount: 2600,
      },
      modelVersion: 'gemini-2.5-flash',
    });
    const provider = new GeminiProvider('key');
    const response = await provider.chat([{ role: 'user', content: 'hi' }]);

    expect(response.usage.input_tokens).toBe(3000 - 2600);
    expect(response.usage.output_tokens).toBe(20);
    expect(response.usage.cache_read_input_tokens).toBe(2600);
  });

  it('omits cache fields when cachedContentTokenCount is absent', async () => {
    mockFetchResponse({
      candidates: [{ content: { parts: [{ text: 'hello' }], role: 'model' }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10, totalTokenCount: 110 },
    });
    const provider = new GeminiProvider('key');
    const response = await provider.chat([{ role: 'user', content: 'hi' }]);

    expect(response.usage.input_tokens).toBe(100);
    expect(response.usage.cache_read_input_tokens).toBeUndefined();
  });
});

describe('GroqProvider automatic-cache usage parsing', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function groqPayload(usage: Record<string, unknown>) {
    return {
      id: 'chatcmpl-groq',
      object: 'chat.completion',
      created: 0,
      model: 'openai/gpt-oss-120b',
      choices: [
        { index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' },
      ],
      usage,
    };
  }

  it('maps prompt_tokens_details.cached_tokens and normalizes input_tokens', async () => {
    mockFetchResponse(groqPayload({
      prompt_tokens: 4641,
      completion_tokens: 33,
      total_tokens: 4674,
      prompt_tokens_details: { cached_tokens: 4608 },
    }));
    const provider = new GroqProvider('key');
    const response = await provider.chat([{ role: 'user', content: 'hi' }]);

    expect(response.usage.input_tokens).toBe(4641 - 4608);
    expect(response.usage.cache_read_input_tokens).toBe(4608);
  });

  it('omits cache fields when prompt_tokens_details is absent', async () => {
    mockFetchResponse(groqPayload({ prompt_tokens: 200, completion_tokens: 15, total_tokens: 215 }));
    const provider = new GroqProvider('key');
    const response = await provider.chat([{ role: 'user', content: 'hi' }]);

    expect(response.usage.input_tokens).toBe(200);
    expect(response.usage.cache_read_input_tokens).toBeUndefined();
  });
});

import { afterEach, describe, expect, test } from 'bun:test';
import { DEFAULT_CONFIG } from '../config/types.ts';
import { testLLMProvider } from './llm-settings.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('testLLMProvider', () => {
  test('accepts the nvidia provider from dashboard settings', async () => {
    const fetchMock = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
      expect(request).toBe('https://integrate.api.nvidia.com/v1/chat/completions');
      expect(init?.method).toBe('POST');
      expect(init?.headers).toMatchObject({
        Authorization: 'Bearer test-key',
        'Content-Type': 'application/json',
      });

      return new Response(JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        created: 1,
        model: 'nim-test-model',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'OK' },
          finish_reason: 'stop',
        }],
        usage: {
          prompt_tokens: 1,
          completion_tokens: 1,
          total_tokens: 2,
        },
      }));
    }, { preconnect: originalFetch.preconnect });

    globalThis.fetch = fetchMock;

    const config = structuredClone(DEFAULT_CONFIG);
    const result = await testLLMProvider(
      { provider: 'nvidia', api_key: 'test-key', model: 'nim-test-model' },
      config,
    );

    expect(result).toEqual({ ok: true, model: 'nim-test-model' });
  });
});

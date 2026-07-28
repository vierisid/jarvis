import { test, expect, describe } from 'bun:test';
import { TelegramAdapter, TelegramSendError, telegramErrorFromResponse } from './telegram.ts';

describe('telegramErrorFromResponse', () => {
  test('returns null for a successful response', () => {
    expect(telegramErrorFromResponse(200, { ok: true, result: {} })).toBeNull();
  });

  test('surfaces retry_after as retryAfterMs on 429', () => {
    const error = telegramErrorFromResponse(429, {
      ok: false,
      error_code: 429,
      description: 'Too Many Requests: retry after 27',
      parameters: { retry_after: 27 },
    });

    expect(error).toBeInstanceOf(TelegramSendError);
    expect(error!.status).toBe(429);
    expect(error!.retryAfterMs).toBe(27_000);
    expect(error!.message).toContain('429');
  });

  test('recognizes a 429 from the body error_code even if the HTTP status differs', () => {
    const error = telegramErrorFromResponse(200, {
      ok: false,
      error_code: 429,
      description: 'Too Many Requests: retry after 5',
      parameters: { retry_after: 5 },
    });

    expect(error!.status).toBe(429);
    expect(error!.retryAfterMs).toBe(5_000);
  });

  test('handles a 429 with missing or garbled parameters', () => {
    const error = telegramErrorFromResponse(429, {
      ok: false,
      error_code: 429,
      description: 'Too Many Requests',
      parameters: { retry_after: 'soon' },
    });

    expect(error!.retryAfterMs).toBeUndefined();
    expect(error!.message).toContain('429');
  });

  test('returns a plain send error without retryAfterMs for non-429 failures', () => {
    const error = telegramErrorFromResponse(400, {
      ok: false,
      error_code: 400,
      description: 'Bad Request: chat not found',
    });

    expect(error!.status).toBe(400);
    expect(error!.retryAfterMs).toBeUndefined();
    expect(error!.message).toBe('Telegram API error: Bad Request: chat not found');
  });

  test('falls back to the HTTP status when the body has no description', () => {
    const error = telegramErrorFromResponse(502, null);

    expect(error!.status).toBe(502);
    expect(error!.message).toBe('Telegram API error: HTTP 502');
  });
});

describe('sendMessage chunking', () => {
  test('tags a mid-chunk failure with the unsent remainder for resumable retries', async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) {
        return { status: 200, json: async () => ({ ok: true }) };
      }
      return {
        status: 429,
        json: async () => ({
          ok: false,
          error_code: 429,
          description: 'Too Many Requests: retry after 3',
          parameters: { retry_after: 3 },
        }),
      };
    }) as unknown as typeof fetch;

    try {
      const adapter = new TelegramAdapter('test-token');
      // 5000 chars with no newlines splits into a 4096 chunk and a 904 chunk.
      const text = 'a'.repeat(5000);

      let thrown: unknown;
      try {
        await adapter.sendMessage('chat-1', text);
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(TelegramSendError);
      const sendError = thrown as TelegramSendError & { remainingText?: string };
      expect(sendError.retryAfterMs).toBe(3_000);
      expect(sendError.remainingText).toBe('a'.repeat(904));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('maps a 5xx with a non-JSON body through the status code so it stays retriable', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      status: 502,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON');
      },
    })) as unknown as typeof fetch;

    try {
      const adapter = new TelegramAdapter('test-token');

      let thrown: unknown;
      try {
        await adapter.sendMessage('chat-1', 'hi');
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(TelegramSendError);
      expect((thrown as TelegramSendError).status).toBe(502);
      expect((thrown as TelegramSendError).message).toBe('Telegram API error: HTTP 502');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

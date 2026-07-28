import { test, expect, describe } from 'bun:test';
import { TelegramSendError, telegramErrorFromResponse } from './telegram.ts';

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

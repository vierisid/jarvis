import { describe, expect, test } from 'bun:test';
import { NotSentError, requestMayHaveArrived, sendFailure, sendRetryable } from './delivery';

const typed = (fields: Record<string, unknown>, message = 'failed') => Object.assign(new Error(message), fields);

describe('send failure classification (Q-19)', () => {
  test.each([
    ['refused before sending', new NotSentError('no recipient'), 'not_sent', false],
    ['a named wait', typed({ retryAfterMs: 3000 }), 'not_sent', true],
    ['a rate limit', typed({ status: 429 }), 'not_sent', true],
    ['a refused request', typed({ status: 400 }), 'not_sent', false],
    ['a forbidden request', typed({ status: 403 }), 'not_sent', false],
    ['a connection never made', typed({ code: 'ECONNREFUSED' }), 'not_sent', true],
    ['a connection never made, on the cause', typed({ cause: { code: 'ConnectionRefused' } }), 'not_sent', true],
    ['a name that did not resolve', typed({ code: 'ENOTFOUND' }), 'not_sent', true],
    ['a server error', typed({ status: 500 }), 'may_have_arrived', false],
    ['a gateway error', typed({ status: 502 }), 'may_have_arrived', false],
    ['a connection dropped after sending', typed({ code: 'ECONNRESET' }), 'may_have_arrived', false],
    ['a socket timeout', typed({ code: 'ETIMEDOUT' }), 'may_have_arrived', false],
    ['a fetch timeout', typed({ name: 'AbortError' }), 'may_have_arrived', false],
    ['an AbortSignal timeout', typed({ name: 'TimeoutError' }), 'may_have_arrived', false],
  ] as const)('%s', (_name, error, failure, retryable) => {
    expect(sendFailure(error)).toBe(failure);
    expect(sendRetryable(error)).toBe(retryable);
  });

  test('wording never classifies: untyped errors may have arrived and are never retried', () => {
    for (const message of ['429 Too Many Requests', 'ECONNREFUSED', 'Bad Request: chat not found', 'not sent']) {
      expect(sendFailure(new Error(message))).toBe('may_have_arrived');
      expect(sendRetryable(new Error(message))).toBe(false);
    }
    expect(sendFailure('a string')).toBe('may_have_arrived');
  });

  test('part of a long message already sent: the message may have arrived, the refused chunk can be resumed', () => {
    const error = typed({ status: 429, remainingText: 'the rest' });
    expect(sendFailure(error)).toBe('may_have_arrived');
    expect(requestMayHaveArrived(error)).toBe(false);
    expect(sendRetryable(error)).toBe(true);
  });
});

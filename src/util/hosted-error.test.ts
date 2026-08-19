import { describe, expect, test } from 'bun:test';
import { hostedProxyError, isBudgetExhaustion } from './hosted-error.ts';

describe('hostedProxyError', () => {
  test('the generic branch never carries the proxy body (hostname stays out of chat copy)', () => {
    // Typical CDN 502 page: the hostname sits in the first line, so even a
    // 120-char truncation leaked it (pr2 review #5).
    const err = hostedProxyError(
      'Usejarvis AI API',
      502,
      '<html><title>502 Bad Gateway</title>error at proxy host llm.usejarvis.host: upstream timeout</html>',
    );
    expect(err.message).toContain('(502)');
    expect(err.message).not.toContain('llm.usejarvis.host');
    expect(err.message).not.toContain('502 Bad Gateway');
  });

  test('budget copy quotes a reset time ONLY when handed one (never parsed from the body)', () => {
    // The 429 budget body carries no reset field (confirmed 2026-08-19); the
    // caller fetches /key/info and passes the parsed Date in.
    const timed = hostedProxyError(
      'Usejarvis AI API',
      429,
      'ExceededBudget: Budget has been exceeded! Current cost: 0.0051, Max budget: 0.005',
      new Date('2026-08-19T12:00:00+00:00'),
    );
    expect(timed.message).toContain('used up for this window (resumes 12:00 UTC)');

    // No timestamp handed in → no time claimed, even if the body smuggles
    // something date-shaped (the old parser would have quoted it).
    const bare = hostedProxyError(
      'Usejarvis AI API',
      429,
      'ExceededBudget: budget has been exceeded, budget_reset_at: 2026-08-18 18:00:00',
    );
    expect(bare.message).toContain('used up for this window.');
    expect(bare.message).not.toMatch(/resumes \d/);

    // An invalid Date degrades identically.
    const invalid = hostedProxyError('Usejarvis AI API', 429, 'budget exceeded', new Date('nonsense'));
    expect(invalid.message).not.toMatch(/resumes \d/);
  });

  test('403 maps to model-not-in-plan even without model text (team_model_access_denied)', () => {
    const err = hostedProxyError('Usejarvis AI API', 403, '{"error":{"code":"team_model_access_denied"}}');
    expect(err.message).toContain('(403)');
    expect(err.message).toContain('not included in your plan');
  });

  test('model-denial TEXT still precedes the auth branch (historical 401 shape)', () => {
    const err = hostedProxyError('Usejarvis AI API', 401, 'key not allowed to access model uj-video');
    expect(err.message).toContain('not included in your plan');
  });

  test('401 without model text is the credential/plan copy', () => {
    const err = hostedProxyError('Usejarvis AI API', 401, 'Authentication Error: key is blocked');
    expect(err.message).toMatch(/\(401\).*active plan is required/);
  });

  test('an ordinary 429 rate limit is NOT budget copy (stays retryable-generic)', () => {
    const err = hostedProxyError('Usejarvis AI API', 429, 'rate limited, retry shortly');
    expect(err.message).toContain('(429)');
    expect(err.message).not.toContain('used up');
  });
});

describe('isBudgetExhaustion', () => {
  test('matches the LiteLLM budget family and nothing else', () => {
    expect(isBudgetExhaustion('ExceededBudget: budget has been exceeded for this key')).toBe(true);
    expect(isBudgetExhaustion('{"error":{"code":"budget_exceeded","message":"over budget"}}')).toBe(true);
    expect(isBudgetExhaustion('rate limited, retry shortly')).toBe(false);
    expect(isBudgetExhaustion('model not allowed')).toBe(false);
  });
});

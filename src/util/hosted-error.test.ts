import { describe, expect, test } from 'bun:test';
import { describeBudgetWindow, hostedProxyError } from './hosted-error.ts';

describe('describeBudgetWindow', () => {
  test('a Postgres-style naive timestamp (space separator) quotes the REAL time', () => {
    // Used to truncate at the space → parse as UTC midnight → "resumes 00:00
    // UTC" for an 18:00 reset (pr2 review #4).
    const body = 'budget_duration: 6h, budget_reset_at: 2026-08-18 18:00:00';
    expect(describeBudgetWindow(body)).toBe('for this 6h window (resumes 18:00 UTC)');
  });

  test('an ISO-T timestamp still works', () => {
    const body = '{"budget_duration":"24h","budget_reset_at":"2026-08-19T06:30:00+00:00"}';
    expect(describeBudgetWindow(body)).toBe('for this 24h window (resumes 06:30 UTC)');
  });

  test('a date with no time-of-day is never quoted as a time', () => {
    const body = 'budget_reset_at: 2026-08-18, budget_duration: 6h';
    expect(describeBudgetWindow(body)).toBe('for this 6h window');
  });

  test('no fields at all degrades to the generic phrase', () => {
    expect(describeBudgetWindow('exceeded budget')).toBe('for this window');
  });
});

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

  test('the budget branch keeps its actionable copy', () => {
    const err = hostedProxyError('Usejarvis AI API', 429, 'ExceededBudget: budget_duration: 6h, budget_reset_at: 2026-08-18 18:00:00');
    expect(err.message).toContain('used up');
    expect(err.message).toContain('resumes 18:00 UTC');
  });

  test('model denial precedes the generic auth branch (401 ordering)', () => {
    const err = hostedProxyError('Usejarvis AI API', 401, 'key not allowed to access model uj-video');
    expect(err.message).toContain('not included in your plan');
  });
});

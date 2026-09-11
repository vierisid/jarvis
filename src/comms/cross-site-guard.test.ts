import { test, expect, describe } from 'bun:test';
import { rejectsCrossSiteWrite } from './cross-site-guard.ts';

describe('rejectsCrossSiteWrite', () => {
  test('rejects cross-site and same-site writes', () => {
    expect(rejectsCrossSiteWrite('POST', 'cross-site', false)).toBe(true);
    expect(rejectsCrossSiteWrite('PATCH', 'same-site', false)).toBe(true);
    expect(rejectsCrossSiteWrite('DELETE', 'Cross-Site', false)).toBe(true);
  });

  test('allows same-origin, user-initiated, and header-less (non-browser) writes', () => {
    expect(rejectsCrossSiteWrite('POST', 'same-origin', false)).toBe(false);
    expect(rejectsCrossSiteWrite('POST', 'none', false)).toBe(false);
    expect(rejectsCrossSiteWrite('POST', null, false)).toBe(false);
  });

  test('reads and preflights are never rejected', () => {
    expect(rejectsCrossSiteWrite('GET', 'cross-site', false)).toBe(false);
    expect(rejectsCrossSiteWrite('HEAD', 'cross-site', false)).toBe(false);
    expect(rejectsCrossSiteWrite('OPTIONS', 'cross-site', false)).toBe(false);
  });

  test('public routes (webhooks) accept cross-site writes by design', () => {
    expect(rejectsCrossSiteWrite('POST', 'cross-site', true)).toBe(false);
  });
});

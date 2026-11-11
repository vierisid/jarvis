import { describe, expect, test } from 'bun:test';
import { humanInputRefusal } from './human-input-contract';

/** #1311 follow-up: the refusal names the cause that applies, for each dashboard and decisions state. */
describe('humanInputRefusal', () => {
  const on = { enabled: true, reason: null }, off = { enabled: false, reason: 'disabled' };

  test('decisions on under Brief: nothing is refused', () => {
    expect(humanInputRefusal(on, 'brief')).toBeNull();
  });

  test('under the previous dashboard a request is refused even with decisions on: Brief, where it is answered, does not open there', () => {
    for (const decisions of [on, off, { enabled: false, reason: 'provider_loading' }]) {
      const text = humanInputRefusal(decisions, 'legacy')!;
      expect(text).toContain('answered only in Brief');
      expect(text).toContain('JARVIS_DASHBOARD=brief');
      expect(text).not.toContain('JARVIS_BRIEF_DECISIONS=1');
    }
  });

  test('decisions off under Brief: turn them on', () => {
    const text = humanInputRefusal(off, 'brief')!;
    expect(text).toContain('JARVIS_BRIEF_DECISIONS=1');
    expect(text).not.toContain('JARVIS_DASHBOARD');
  });

  test('a provider that is not ready is not told to set a flag it already set', () => {
    for (const reason of ['provider_loading', 'provider_unavailable', 'provider_missing', 'dependency_not_ready']) {
      const text = humanInputRefusal({ enabled: false, reason }, 'brief')!;
      expect(text).toContain('not ready');
      expect(text).not.toContain('JARVIS_');
    }
  });
});

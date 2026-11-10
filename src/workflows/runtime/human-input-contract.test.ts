import { describe, expect, test } from 'bun:test';
import { humanInputRefusal } from './human-input-contract';

/** #1311 follow-up: the refusal names the cause that applies, for each dashboard and decisions state. */
describe('humanInputRefusal', () => {
  const on = { enabled: true, reason: null }, off = { enabled: false, reason: 'disabled' };

  test('decisions on: nothing is refused, under either dashboard', () => {
    expect(humanInputRefusal(on, 'brief')).toBeNull();
    expect(humanInputRefusal(on, 'legacy')).toBeNull();
  });

  test('decisions off under Brief: turn them on', () => {
    const text = humanInputRefusal(off, 'brief')!;
    expect(text).toContain('JARVIS_BRIEF_DECISIONS=1');
    expect(text).not.toContain('JARVIS_DASHBOARD');
  });

  test('decisions off under the previous dashboard: requests are answered only in Brief, so switch', () => {
    const text = humanInputRefusal(off, 'legacy')!;
    expect(text).toContain('answered only in Brief');
    expect(text).toContain('JARVIS_DASHBOARD=brief');
    expect(text).toContain('JARVIS_HOSTED_DASHBOARD unset');
    expect(text).not.toContain('JARVIS_BRIEF_DECISIONS=1');
  });

  test('a provider that is not ready is not told to set a flag it already set', () => {
    for (const reason of ['provider_loading', 'provider_unavailable', 'provider_missing', 'dependency_not_ready']) {
      for (const dashboard of ['brief', 'legacy'] as const) {
        const text = humanInputRefusal({ enabled: false, reason }, dashboard)!;
        expect(text).toContain('not ready');
        expect(text).not.toContain('JARVIS_');
      }
    }
  });
});

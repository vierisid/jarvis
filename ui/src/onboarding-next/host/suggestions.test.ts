import { describe, expect, test } from 'bun:test';
import { suggestionsFrom } from './suggestions';

const snapshot = (entry: Record<string, unknown>) => ({ contractVersion: 1, capabilities: { preparedOpportunities: entry } });
const ready = { supported: true, ready: true, enabled: true, state: 'ready', reason: null };
const disabled = { supported: true, ready: false, enabled: false, state: 'disabled', reason: 'disabled' };

describe('onboarding suggestions availability', () => {
  test('on only when the capability is confirmed enabled', () => {
    expect(suggestionsFrom(snapshot(ready), 'self')).toBe('on');
    expect(suggestionsFrom(snapshot(ready), 'hosted')).toBe('on');
  });
  test('a disabled capability is off, and self-hosted keeps the setup hint', () => {
    expect(suggestionsFrom(snapshot(disabled), 'self')).toBe('self');
    expect(suggestionsFrom(snapshot(disabled), 'hosted')).toBe('off');
  });
  test('an unreadable snapshot never counts as on', () => {
    expect(suggestionsFrom(null, 'hosted')).toBe('off');
    expect(suggestionsFrom({}, 'self')).toBe('self');
  });
});

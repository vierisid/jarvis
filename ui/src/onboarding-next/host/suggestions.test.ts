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
  test('an unreadable snapshot never counts as on, and gives no setup hint', () => {
    expect(suggestionsFrom(null, 'hosted')).toBe('off');
    expect(suggestionsFrom(null, 'self')).toBe('off');
    expect(suggestionsFrom({}, 'self')).toBe('off');
  });
  test('a self-hosted install whose provider is not ready is off without the setup hint', () => {
    // The operator may already have set the flag; telling them to set it again would mislead.
    const loading = { supported: true, ready: false, enabled: false, state: 'loading', reason: 'provider_loading' };
    const unavailable = { supported: true, ready: false, enabled: false, state: 'unavailable', reason: 'provider_unavailable' };
    const missing = { supported: false, ready: false, enabled: false, state: 'unsupported', reason: 'provider_missing' };
    for (const entry of [loading, unavailable, missing]) expect(suggestionsFrom(snapshot(entry), 'self')).toBe('off');
    expect(suggestionsFrom(snapshot(disabled), 'unknown')).toBe('off');
  });
});

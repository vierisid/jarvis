import { describe, expect, test } from 'bun:test';
import { NOTCH_SWITCH, notchEnabled } from './switch.ts';

describe('the notch switch', () => {
  test('is off when the variable is absent', () => {
    expect(notchEnabled({})).toBe(false);
  });

  test('is on only for exactly "1"', () => {
    expect(notchEnabled({ [NOTCH_SWITCH]: '1' })).toBe(true);
  });

  // A dark feature must not come on by a near miss. Each of these is a value
  // somebody would plausibly type meaning "on".
  for (const value of ['true', 'yes', 'on', 'TRUE', ' 1', '1 ', '01', '2', '']) {
    test(`stays off for ${JSON.stringify(value)}`, () => {
      expect(notchEnabled({ [NOTCH_SWITCH]: value })).toBe(false);
    });
  }

  test('reads the name the launch scripts set', () => {
    // scripts/integration/dev.ts and scripts/notch/try.sh pass this exact name.
    expect(NOTCH_SWITCH).toBe('JARVIS_NOTCH');
  });
});

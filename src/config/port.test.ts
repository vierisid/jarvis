import { describe, expect, test } from 'bun:test';
import { MAX_PORT, MIN_PORT, readPortSetting, requirePort } from './port.ts';

/**
 * The one reading of `daemon.port` that both the daemon's bind path and
 * `jarvis stop` go through (#550). What it accepts, it accepts for both; what
 * it rejects, neither guesses at.
 */
describe('readPortSetting', () => {
  test('a number in range is the port', () => {
    for (const port of [MIN_PORT, 80, 3142, 8080, MAX_PORT]) {
      expect(readPortSetting(port)).toEqual({ kind: 'valid', port });
    }
  });

  test('a quoted port is the same port as an unquoted one', () => {
    // The bug: YAML makes `port: "8080"` a string, and both readers took only
    // a number, so the daemon bound 8080 and the CLI aimed at 3142.
    expect(readPortSetting('8080')).toEqual(readPortSetting(8080));
    expect(readPortSetting('8080')).toEqual({ kind: 'valid', port: 8080 });
    expect(readPortSetting(' 8080 ')).toEqual({ kind: 'valid', port: 8080 });
    expect(readPortSetting('08080')).toEqual({ kind: 'valid', port: 8080 });
    expect(readPortSetting(String(MAX_PORT))).toEqual({ kind: 'valid', port: MAX_PORT });
  });

  test('nothing set is absent, not invalid, so the caller can apply its default', () => {
    expect(readPortSetting(undefined)).toEqual({ kind: 'absent' });
    // `port:` with no value parses as null.
    expect(readPortSetting(null)).toEqual({ kind: 'absent' });
  });

  // Each of these has to be invalid rather than absent: "absent" means the
  // caller falls back to 3142, and reaching 3142 by accident is the bug.
  const rejected: [string, unknown][] = [
    ['zero, which Bun.serve reads as "any free port"', 0],
    ['a string zero', '0'],
    ['one past the top', 65536],
    ['a string one past the top', '65536'],
    ['negative', -1],
    ['a negative string', '-1'],
    ['a fraction', 8080.5],
    ['a fraction as a string', '8080.5'],
    ['a trailing zero fraction as a string', '8080.0'],
    ['digits with a suffix', '8080abc'],
    ['hex', '0x1f90'],
    ['exponent notation', '8e3'],
    ['a leading plus', '+8080'],
    ['thousands separators', '8_080'],
    ['empty string', ''],
    ['whitespace only', '   '],
    ['a word', 'not-a-port'],
    ['more digits than any port', '99999999999999999999'],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a boolean', true],
    ['a list', [8080]],
    ['a mapping', { nope: true }],
  ];

  test.each(rejected)('rejects %s', (_label, value) => {
    const setting = readPortSetting(value);
    expect(setting.kind).toBe('invalid');
    // The message has to name the constraint and the value, since the whole
    // point is that the user finds and fixes the typo.
    expect(setting.kind === 'invalid' ? setting.problem : '').toMatch(/between 1 and 65535/);
  });

  test('the message quotes a bad string and names a container by shape', () => {
    const problem = (value: unknown) => {
      const setting = readPortSetting(value);
      return setting.kind === 'invalid' ? setting.problem : '';
    };
    expect(problem('8080abc')).toContain('got "8080abc"');
    expect(problem(65536)).toContain('got 65536');
    expect(problem([8080])).toContain('got a list');
    expect(problem({ nope: true })).toContain('got a mapping');
    // A quoted port is fine, and the message says so, because the reader that
    // used to reject one is the reader people will be reading about.
    expect(problem('')).toContain('a quoted "8080" is fine');
  });

  test('a huge string is clamped, not reproduced in full', () => {
    // This message reaches the daemon's boot error, `jarvis stop`'s output and
    // the dashboard label, so a daemon.port holding a novel must not be printed
    // three times over.
    const setting = readPortSetting('8'.repeat(5000));
    const problem = setting.kind === 'invalid' ? setting.problem : '';
    expect(problem.length).toBeLessThan(120);
    expect(problem).toContain('...');
    // Still valid JSON quoting, so the clamp cannot split an escape sequence.
    expect(() => JSON.parse(problem.slice(problem.indexOf('got ') + 4))).not.toThrow();
  });
});

describe('requirePort', () => {
  test('returns the coerced port and undefined for absent', () => {
    expect(requirePort(8080, 'daemon.port')).toBe(8080);
    expect(requirePort('8080', 'daemon.port')).toBe(8080);
    expect(requirePort(undefined, 'daemon.port')).toBeUndefined();
    expect(requirePort(null, 'daemon.port')).toBeUndefined();
  });

  test('throws with the label in front of the problem', () => {
    expect(() => requirePort('8080abc', 'daemon.port in /home/me/.jarvis/config.yaml'))
      .toThrow('daemon.port in /home/me/.jarvis/config.yaml must be a whole number between 1 and 65535 (a quoted "8080" is fine), got "8080abc"');
    expect(() => requirePort(0, 'daemon.port')).toThrow(/^daemon\.port must be/);
  });
});

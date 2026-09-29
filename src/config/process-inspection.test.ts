import { describe, expect, test } from 'bun:test';
import {
  readProcessInspectionSetting,
  resolveAllowProcessInspection,
} from './process-inspection.ts';

/**
 * The one reading of `daemon.allow_process_inspection`, the escape hatch for
 * #546's `prctl(PR_SET_DUMPABLE, 0)`. What matters here is the asymmetry: the
 * permissive answer is only ever given for a value that unambiguously asks for
 * it, and everything else -- absent, malformed, the wrong type -- leaves the
 * daemon hardened.
 */
describe('readProcessInspectionSetting', () => {
  test('a boolean is the answer', () => {
    expect(readProcessInspectionSetting(true)).toEqual({ kind: 'valid', allow: true });
    expect(readProcessInspectionSetting(false)).toEqual({ kind: 'valid', allow: false });
  });

  test('the YAML 1.1 spellings the parser leaves as strings mean what they say', () => {
    // `allow_process_inspection: yes` is the STRING "yes" under the YAML 1.2
    // core schema the `yaml` package parses to. Reading that as "not true"
    // would leave the hatch shut for someone who clearly opened it.
    for (const yes of ['yes', 'YES', 'on', 'On', 'true', 'TRUE', ' true ', '1']) {
      expect(readProcessInspectionSetting(yes)).toEqual({ kind: 'valid', allow: true });
    }
    for (const no of ['no', 'NO', 'off', 'Off', 'false', 'FALSE', ' false ', '0']) {
      expect(readProcessInspectionSetting(no)).toEqual({ kind: 'valid', allow: false });
    }
  });

  test('a bare 1 or 0 is a number by the time it arrives', () => {
    expect(readProcessInspectionSetting(1)).toEqual({ kind: 'valid', allow: true });
    expect(readProcessInspectionSetting(0)).toEqual({ kind: 'valid', allow: false });
  });

  test('nothing set is absent, not invalid', () => {
    expect(readProcessInspectionSetting(undefined)).toEqual({ kind: 'absent' });
    // `allow_process_inspection:` with no value parses as null.
    expect(readProcessInspectionSetting(null)).toEqual({ kind: 'absent' });
  });

  // Each of these must be `invalid` rather than `valid, allow: true`: a
  // truthiness test on any of them would switch the hardening off.
  const rejected: [string, unknown][] = [
    ['a word', 'maybe'],
    ['a truthy-looking string that is not a yes', 'enabled'],
    ['a string that merely contains yes', 'yes please'],
    ['an empty string', ''],
    ['whitespace only', '  '],
    ['a number that is not 1 or 0', 2],
    ['a negative number', -1],
    ['NaN', Number.NaN],
    ['a list', [true]],
    ['a mapping', { allow: true }],
    ['a function', () => true],
  ];

  test.each(rejected)('rejects %s', (_label, value) => {
    const setting = readProcessInspectionSetting(value);
    expect(setting.kind).toBe('invalid');
    expect(setting).toHaveProperty('problem');
  });

  test('a long string is clamped in the message rather than reproduced', () => {
    const setting = readProcessInspectionSetting('x'.repeat(5_000));
    expect(setting.kind).toBe('invalid');
    if (setting.kind !== 'invalid') throw new Error('unreachable');
    expect(setting.problem.length).toBeLessThan(200);
    expect(setting.problem).toContain('...');
  });
});

describe('resolveAllowProcessInspection', () => {
  const warnings: string[] = [];
  const warn = (line: string): void => {
    warnings.push(line);
  };

  test('only an explicit yes allows inspection', () => {
    expect(resolveAllowProcessInspection(true, 'k', warn)).toBe(true);
    expect(resolveAllowProcessInspection('yes', 'k', warn)).toBe(true);
    expect(resolveAllowProcessInspection(1, 'k', warn)).toBe(true);
  });

  test('absent leaves the daemon hardened, silently: it is the default', () => {
    warnings.length = 0;
    expect(resolveAllowProcessInspection(undefined, 'k', warn)).toBe(false);
    expect(resolveAllowProcessInspection(null, 'k', warn)).toBe(false);
    expect(warnings).toEqual([]);
  });

  test('an explicit no leaves it hardened, silently', () => {
    warnings.length = 0;
    expect(resolveAllowProcessInspection(false, 'k', warn)).toBe(false);
    expect(resolveAllowProcessInspection('off', 'k', warn)).toBe(false);
    expect(warnings).toEqual([]);
  });

  test('a malformed value fails CLOSED and says so out loud', () => {
    // The whole mitigation for not throwing. An operator who wrote something
    // we cannot read meant to change something and has to hear that it did
    // not take effect.
    warnings.length = 0;
    expect(resolveAllowProcessInspection('maybe', 'daemon.allow_process_inspection in /c.yaml', warn)).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('daemon.allow_process_inspection in /c.yaml');
    expect(warnings[0]).toContain('"maybe"');
    // Says which way it went, so the operator knows the hatch did not open.
    expect(warnings[0]).toContain('keep blocking process inspection');
  });
});

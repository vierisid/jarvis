import { describe, expect, test } from 'bun:test';
import {
  classifySidecarVersion,
  compareSemver,
  parseSemver,
  SIDECAR_RECOMMENDED_VERSION,
} from './compat.ts';

describe('parseSemver', () => {
  test('parses plain X.Y.Z', () => {
    expect(parseSemver('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: '' });
  });
  test('tolerates leading v and +build', () => {
    expect(parseSemver('v1.2.3+abc')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: '' });
  });
  test('captures prerelease', () => {
    expect(parseSemver('1.2.3-rc.1')?.prerelease).toBe('rc.1');
  });
  test('returns null for dev / garbage', () => {
    expect(parseSemver('dev')).toBeNull();
    expect(parseSemver('')).toBeNull();
    expect(parseSemver('1.2')).toBeNull();
  });
});

describe('compareSemver', () => {
  const v = (s: string) => parseSemver(s)!;
  test('orders by core', () => {
    expect(compareSemver(v('1.0.0'), v('2.0.0'))).toBeLessThan(0);
    expect(compareSemver(v('1.3.0'), v('1.2.9'))).toBeGreaterThan(0);
    expect(compareSemver(v('1.2.3'), v('1.2.3'))).toBe(0);
  });
  test('prerelease sorts before its release', () => {
    expect(compareSemver(v('1.0.0-rc.1'), v('1.0.0'))).toBeLessThan(0);
    expect(compareSemver(v('1.0.0'), v('1.0.0-rc.1'))).toBeGreaterThan(0);
  });
});

describe('classifySidecarVersion', () => {
  test('dev/unparseable is never blocked', () => {
    expect(classifySidecarVersion('dev')).toBe('dev');
    expect(classifySidecarVersion('garbage')).toBe('dev');
  });
  test('at or above the seeded floors is ok', () => {
    expect(classifySidecarVersion(SIDECAR_RECOMMENDED_VERSION)).toBe('ok');
    expect(classifySidecarVersion('99.0.0')).toBe('ok');
  });
  test('below MIN is blocked', () => {
    // 0.0.0 is below any floor greater than 0.0.0 (the seeded floor is 0.1.0).
    expect(classifySidecarVersion('0.0.0')).toBe('blocked');
  });
});

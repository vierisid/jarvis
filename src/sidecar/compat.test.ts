import { describe, expect, test } from 'bun:test';
import {
  classifySidecarVersion,
  compareSemver,
  isUpdateAvailable,
  parseSemver,
  SIDECAR_LATEST_VERSION,
  SIDECAR_MIN_VERSION,
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
  test('locks the MIN<=v<RECOMMENDED ordering the "suggested" branch relies on', () => {
    // classifySidecarVersion returns 'suggested' only when min <= v < recommended.
    // With the seeded floors equal (0.1.0) that branch is unreachable today, so
    // pin the comparison directly — the first time RECOMMENDED is bumped above
    // MIN this is the logic that goes live, and it currently has no other cover.
    const min = v('0.1.0');
    const recommended = v('0.2.0');
    const between = v('0.1.5');
    expect(compareSemver(between, min)).toBeGreaterThanOrEqual(0); // not blocked
    expect(compareSemver(between, recommended)).toBeLessThan(0);   // would be 'suggested'
    expect(compareSemver(min, min)).toBe(0);                       // exactly MIN is not blocked
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

describe('isUpdateAvailable', () => {
  test('a sidecar behind the version this brain ships with is behind', () => {
    expect(isUpdateAvailable('0.9.7', '0.10.0')).toBe(true);
    expect(isUpdateAvailable('0.10.0-rc.1', '0.10.0')).toBe(true);
  });
  test('an equal or newer sidecar is not', () => {
    expect(isUpdateAvailable('0.10.0', '0.10.0')).toBe(false);
    expect(isUpdateAvailable('0.11.0', '0.10.0')).toBe(false);
  });
  test('a release build is never offered a prerelease', () => {
    expect(isUpdateAvailable('0.9.7', '0.10.0-rc.1')).toBe(false);
    expect(isUpdateAvailable('0.10.0-rc.1', '0.10.0-rc.2')).toBe(true);
  });
  test('prerelease identifiers compare numerically, as the sidecar does', () => {
    expect(isUpdateAvailable('0.10.0-rc.9', '0.10.0-rc.10')).toBe(true);
    expect(isUpdateAvailable('0.10.0-rc.10', '0.10.0-rc.9')).toBe(false);
    expect(isUpdateAvailable('0.10.0-rc.1', '0.10.0-rc.1.1')).toBe(true);
    expect(isUpdateAvailable('0.10.0-1', '0.10.0-alpha')).toBe(true);
  });
  test('non-canonical stamps are not offered an update (the sidecar would refuse it)', () => {
    expect(isUpdateAvailable('v0.9.7', '0.10.0')).toBe(false);
    expect(isUpdateAvailable('0.9.7+local', '0.10.0')).toBe(false);
  });
  test('dev, unparseable and missing versions never are', () => {
    expect(isUpdateAvailable('dev', '0.10.0')).toBe(false);
    expect(isUpdateAvailable('', '0.10.0')).toBe(false);
    expect(isUpdateAvailable(undefined, '0.10.0')).toBe(false);
    expect(isUpdateAvailable(null, '0.10.0')).toBe(false);
  });
  test('defaults to SIDECAR_LATEST_VERSION', () => {
    expect(isUpdateAvailable(SIDECAR_LATEST_VERSION)).toBe(false);
    expect(isUpdateAvailable('0.0.1')).toBe(true);
  });
});

describe('floors and latest', () => {
  // A rejected sidecar is told to update to SIDECAR_LATEST_VERSION; that
  // version has to be one this brain accepts, or the update leads nowhere.
  test('MIN <= RECOMMENDED <= LATEST', () => {
    const v = (s: string) => parseSemver(s)!;
    expect(compareSemver(v(SIDECAR_MIN_VERSION), v(SIDECAR_RECOMMENDED_VERSION))).toBeLessThanOrEqual(0);
    expect(compareSemver(v(SIDECAR_RECOMMENDED_VERSION), v(SIDECAR_LATEST_VERSION))).toBeLessThanOrEqual(0);
    expect(classifySidecarVersion(SIDECAR_LATEST_VERSION)).toBe('ok');
  });
});

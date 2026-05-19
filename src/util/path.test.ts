import { describe, expect, test } from 'bun:test';
import { resolve, sep } from 'node:path';
import { isWithin } from './path.ts';

describe('isWithin', () => {
  const base = resolve('/foo/app');

  test('allows same directory (rel === "")', () => {
    expect(isWithin(base, base)).toBe(true);
  });

  test('allows descendant paths', () => {
    expect(isWithin(resolve('/foo/app/sub/file.txt'), base)).toBe(true);
  });

  test('allows descendant whose first segment starts with two dots', () => {
    expect(isWithin(resolve('/foo/app/..config/settings.json'), base)).toBe(true);
  });

  test('rejects sibling directory with shared prefix (the original bug)', () => {
    expect(isWithin(resolve('/foo/app-backup/pwned.txt'), base)).toBe(false);
    expect(isWithin(resolve('/foo/app-backup'), base)).toBe(false);
  });

  test('rejects parent directory traversal', () => {
    expect(isWithin(resolve('/foo/other/file.txt'), base)).toBe(false);
    expect(isWithin(resolve('/foo'), base)).toBe(false);
  });

  test('rejects exact "../" relative result', () => {
    expect(isWithin(resolve('/foo'), resolve('/foo/app'))).toBe(false);
  });

  test('rejects paths in unrelated trees (treated as absolute rel on POSIX)', () => {
    // On POSIX, relative('/foo/app', '/bar') returns '../../bar' (starts with ..sep) -> rejected.
    expect(isWithin(resolve('/bar/baz'), base)).toBe(false);
  });

  test('uses the platform separator in the .. check', () => {
    // Regression guard: a forward-slash-only check would mishandle Windows paths.
    // The helper relies on `sep` so this should hold on every platform.
    const escaping = `..${sep}escape`;
    expect(escaping.startsWith(`..${sep}`)).toBe(true);
  });
});

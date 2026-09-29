import { afterEach, beforeEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sanitizedEnv } from '../../util/subprocess-env';
import { fingerprintSource } from './source';

let root: string;
const snapshot = () => fingerprintSource(root, ['tracked.ts', 'untracked.ts']);
// A pre-commit hook exports GIT_DIR/GIT_INDEX_FILE; inheriting them would run
// these commands against the committing repository instead of the temp one.
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, env: sanitizedEnv() });
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jarvis-source-fingerprint-'));
  git('init', '--quiet');
  writeFileSync(join(root, 'tracked.ts'), 'export const value = 1;');
  git('add', 'tracked.ts');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test('an unstaged tracked deletion is recorded and differs from an empty or absent file', () => {
  const original = snapshot();
  writeFileSync(join(root, 'tracked.ts'), '');
  const empty = snapshot();
  rmSync(join(root, 'tracked.ts'));
  const deleted = snapshot();
  expect(deleted).toMatchObject({
    sourceFingerprintVersion: 2, sourcePaths: ['tracked.ts'], deletedSourcePaths: ['tracked.ts'],
  });
  expect(snapshot()).toEqual(deleted);
  git('rm', '--cached', 'tracked.ts');
  const absent = snapshot();
  expect(absent).toMatchObject({ sourcePaths: [], deletedSourcePaths: [] });
  expect(new Set([original, empty, deleted, absent].map(s => s.sourceSha256)).size).toBe(4);
});

test('source fingerprint includes untracked content and is independent of pathspec order', () => {
  const original = snapshot();
  writeFileSync(join(root, 'untracked.ts'), 'export const added = true;');
  const added = snapshot();
  expect(added.sourcePaths).toEqual(['tracked.ts', 'untracked.ts']);
  expect(added.sourceSha256).not.toBe(original.sourceSha256);
  expect(fingerprintSource(root, ['untracked.ts', 'tracked.ts'])).toEqual(added);
  writeFileSync(join(root, 'untracked.ts'), 'export const added = false;');
  expect(snapshot().sourceSha256).not.toBe(added.sourceSha256);
});

test('unrelated read errors are not treated as deleted source', () => {
  rmSync(join(root, 'tracked.ts'));
  mkdirSync(join(root, 'tracked.ts'));
  expect(snapshot).toThrow();
});

test('source inventory ignores inherited Git repository overrides', () => {
  const expected = snapshot();
  const previous = process.env.GIT_DIR;
  process.env.GIT_DIR = join(root, 'missing-git-dir');
  try {
    expect(snapshot()).toEqual(expected);
  } finally {
    if (previous === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previous;
  }
});

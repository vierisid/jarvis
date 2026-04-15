import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { rm } from 'node:fs/promises';
import { getInstalledVersion, selectInstalledVersion } from './version.ts';

const TEMP_DIRS: string[] = [];

function makeTempDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `jarvis-version-test-${name}-`));
  const resolved = resolve(dir);
  if (resolved === resolve(process.cwd())) {
    throw new Error('Refusing to use the current worktree as a test temp directory');
  }
  TEMP_DIRS.push(resolved);
  return resolved;
}

async function writePackageJson(dir: string, version: string): Promise<void> {
  await Bun.write(join(dir, 'package.json'), JSON.stringify({ name: '@usejarvis/brain', version }, null, 2));
}

async function writeFakeGit(dir: string, script: string): Promise<void> {
  const binDir = join(dir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const gitPath = join(binDir, 'git');
  await Bun.write(gitPath, script);
  chmodSync(gitPath, 0o755);
}

async function withFakeGit<T>(name: string, script: string, run: (packageRoot: string) => Promise<T>): Promise<T> {
  const dir = makeTempDir(name);
  await writePackageJson(dir, '0.4.0');
  mkdirSync(join(dir, '.git'));
  await writeFakeGit(dir, script);

  const previousGitBin = process.env.JARVIS_GIT_BIN;
  process.env.JARVIS_GIT_BIN = join(dir, 'bin', 'git');
  try {
    return await run(dir);
  } finally {
    if (previousGitBin === undefined) {
      delete process.env.JARVIS_GIT_BIN;
    } else {
      process.env.JARVIS_GIT_BIN = previousGitBin;
    }
  }
}

afterEach(async () => {
  await Promise.all(TEMP_DIRS.splice(0).map(async (dir) => {
    if (existsSync(dir)) {
      await rm(dir, { recursive: true, force: true });
    }
  }));
});

describe('CLI version resolver', () => {
  test('reads an exact release tag through the git resolver path', async () => {
    await withFakeGit(
      'exact-tag',
      `#!/usr/bin/env bash
if [ "$1" = "-C" ] && [ "$3" = "describe" ] && [ "$4" = "--tags" ] && [ "$5" = "--exact-match" ]; then
  printf 'v9.9.9\\n'
  exit 0
fi
exit 1
`,
      async (dir) => {
        expect(getInstalledVersion(dir)).toBe('v9.9.9');
      },
    );
  });

  test('falls back to git describe when HEAD is ahead of the last tag', async () => {
    await withFakeGit(
      'described-version',
      `#!/usr/bin/env bash
if [ "$1" = "-C" ] && [ "$3" = "describe" ] && [ "$4" = "--tags" ] && [ "$5" = "--exact-match" ]; then
  exit 1
fi
if [ "$1" = "-C" ] && [ "$3" = "describe" ] && [ "$4" = "--tags" ] && [ "$5" = "--always" ]; then
  printf 'v1.2.3-1-gabc123\\n'
  exit 0
fi
exit 1
`,
      async (dir) => {
        expect(getInstalledVersion(dir)).toBe('v1.2.3-1-gabc123');
      },
    );
  });

  test('prefers the exact release tag over other version sources', () => {
    expect(selectInstalledVersion('0.4.0', 'v9.9.9', 'v9.9.9-1-gabc123')).toBe('v9.9.9');
  });

  test('uses git describe output when the checkout is ahead of the last release tag', () => {
    expect(selectInstalledVersion('0.4.0', null, 'v1.2.3-1-gabc123')).toBe('v1.2.3-1-gabc123');
  });

  test('falls back to package.json version when git metadata is unavailable', async () => {
    const dir = makeTempDir('package-only');
    await writePackageJson(dir, '3.2.1');
    expect(selectInstalledVersion('3.2.1', null, null)).toBe('3.2.1');
    expect(getInstalledVersion(dir)).toBe('3.2.1');
  });
});

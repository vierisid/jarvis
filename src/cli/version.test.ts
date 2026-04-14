import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync } from 'node:fs';
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

afterEach(async () => {
  await Promise.all(TEMP_DIRS.splice(0).map(async (dir) => {
    if (existsSync(dir)) {
      await rm(dir, { recursive: true, force: true });
    }
  }));
});

describe('CLI version resolver', () => {
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

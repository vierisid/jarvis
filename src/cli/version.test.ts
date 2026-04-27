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

// Builds a fake-git script that always succeeds for `rev-parse --git-dir`
// (so isGitCheckout returns true) and lets the caller specify how the
// `describe` invocations should behave. Note: $1=-C, $2=cwd, $3=subcommand,
// $4..=flags.
function fakeGitScript(describeBranch: string): string {
  return `#!/usr/bin/env bash
if [ "$3" = "rev-parse" ] && [ "$4" = "--git-dir" ]; then
  printf '.git\\n'
  exit 0
fi
${describeBranch}
exit 1
`;
}

async function withFakeGit<T>(
  name: string,
  describeBranch: string,
  run: (packageRoot: string) => Promise<T>,
): Promise<T> {
  const dir = makeTempDir(name);
  await writePackageJson(dir, '0.4.0');
  await writeFakeGit(dir, fakeGitScript(describeBranch));

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
  test('reads an exact release tag and strips the leading v', async () => {
    await withFakeGit(
      'exact-tag',
      `if [ "$3" = "describe" ] && [ "$4" = "--tags" ] && [ "$5" = "--exact-match" ]; then
  printf 'v9.9.9\\n'
  exit 0
fi`,
      async (dir) => {
        expect(getInstalledVersion(dir)).toBe('9.9.9');
      },
    );
  });

  test('falls back to git describe when HEAD is ahead of the last tag', async () => {
    await withFakeGit(
      'described-version',
      `if [ "$3" = "describe" ] && [ "$4" = "--tags" ] && [ "$5" = "--exact-match" ]; then
  exit 1
fi
if [ "$3" = "describe" ] && [ "$4" = "--tags" ] && [ "$5" = "--always" ]; then
  printf 'v1.2.3-1-gabc123\\n'
  exit 0
fi`,
      async (dir) => {
        expect(getInstalledVersion(dir)).toBe('1.2.3-1-gabc123');
      },
    );
  });

  test('does not run --always when --exact-match resolves a tag', async () => {
    // The fake git exits 99 if --always is invoked; the resolver must
    // never reach it on a tagged commit.
    await withFakeGit(
      'short-circuit',
      `if [ "$3" = "describe" ] && [ "$4" = "--tags" ] && [ "$5" = "--exact-match" ]; then
  printf 'v0.5.0\\n'
  exit 0
fi
if [ "$3" = "describe" ] && [ "$4" = "--tags" ] && [ "$5" = "--always" ]; then
  exit 99
fi`,
      async (dir) => {
        expect(getInstalledVersion(dir)).toBe('0.5.0');
      },
    );
  });

  test('rejects bare-SHA describe output and falls back to package.json', async () => {
    await withFakeGit(
      'tagless-repo',
      `if [ "$3" = "describe" ] && [ "$4" = "--tags" ] && [ "$5" = "--exact-match" ]; then
  exit 1
fi
if [ "$3" = "describe" ] && [ "$4" = "--tags" ] && [ "$5" = "--always" ]; then
  printf 'abc1234\\n'
  exit 0
fi`,
      async (dir) => {
        // Package.json was seeded with 0.4.0 by the harness; the bare SHA
        // must be rejected as not-a-version.
        expect(getInstalledVersion(dir)).toBe('0.4.0');
      },
    );
  });

  test('falls back to package.json when not a git checkout', async () => {
    const dir = makeTempDir('non-git');
    await writePackageJson(dir, '3.2.1');
    // Point JARVIS_GIT_BIN at a non-existent file so rev-parse fails →
    // isGitCheckout returns false and we never call describe.
    const previousGitBin = process.env.JARVIS_GIT_BIN;
    process.env.JARVIS_GIT_BIN = join(dir, 'no-such-git-binary');
    try {
      expect(getInstalledVersion(dir)).toBe('3.2.1');
    } finally {
      if (previousGitBin === undefined) delete process.env.JARVIS_GIT_BIN;
      else process.env.JARVIS_GIT_BIN = previousGitBin;
    }
  });

  // ── pure selector ─────────────────────────────────────────────────

  test('selectInstalledVersion: exact tag wins (v stripped)', () => {
    expect(selectInstalledVersion('v9.9.9', 'v9.9.9-1-gabc123', '0.4.0')).toBe('9.9.9');
  });

  test('selectInstalledVersion: described wins when no exact tag (v stripped)', () => {
    expect(selectInstalledVersion(null, 'v1.2.3-1-gabc123', '0.4.0')).toBe('1.2.3-1-gabc123');
  });

  test('selectInstalledVersion: package.json wins when neither git source resolves', () => {
    expect(selectInstalledVersion(null, null, '3.2.1')).toBe('3.2.1');
  });

  test('selectInstalledVersion: leaves tags without a v prefix unchanged', () => {
    expect(selectInstalledVersion('1.0.0', null, '0.0.0')).toBe('1.0.0');
  });
});

// ── End-to-end CLI smoke tests ──────────────────────────────────────
// Run the real `bin/jarvis.ts --version` / `version` paths so the banner
// `v`-prefixing contract is locked. The matcher unit tests above verify
// the resolver's shape; these prove the call sites add `v` consistently.

describe('CLI --version output', () => {
  const REPO_ROOT = resolve(import.meta.dir, '..', '..');
  const JARVIS_BIN = join(REPO_ROOT, 'bin', 'jarvis.ts');

  async function runCli(args: string[]): Promise<{ exitCode: number; stdout: string }> {
    const proc = Bun.spawn(['bun', JARVIS_BIN, ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
      cwd: REPO_ROOT,
    });
    const exitCode = await proc.exited;
    const stdout = (await new Response(proc.stdout).text()).trim();
    return { exitCode, stdout };
  }

  test('`jarvis --version` prints v-prefixed version with no doubling', async () => {
    const { exitCode, stdout } = await runCli(['--version']);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/^v\d+\.\d+/);
    expect(stdout.startsWith('vv')).toBe(false);
  }, { timeout: 15000 });

  test('`jarvis version` matches `--version` output', async () => {
    const a = await runCli(['version']);
    const b = await runCli(['--version']);
    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);
    expect(a.stdout).toBe(b.stdout);
  }, { timeout: 15000 });

  test('`jarvis -v` matches `--version` output', async () => {
    const a = await runCli(['-v']);
    const b = await runCli(['--version']);
    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);
    expect(a.stdout).toBe(b.stdout);
  }, { timeout: 15000 });

  test('`jarvis help` banner contains exactly one v-prefixed version (no vv)', async () => {
    const { exitCode, stdout } = await runCli(['help']);
    expect(exitCode).toBe(0);
    expect(stdout).not.toMatch(/vv\d+\.\d+/);
    expect(stdout).toMatch(/v\d+\.\d+/);
  }, { timeout: 15000 });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'bun';

function readPackageVersion(packageRoot: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf-8')) as { version?: unknown };
    if (typeof pkg.version !== 'string' || pkg.version.length === 0) return '0.0.0';
    return pkg.version;
  } catch {
    return '0.0.0';
  }
}

// JARVIS_GIT_BIN is a test-only seam: lets unit tests substitute a fake
// git binary so we don't depend on the host's real git installation.
function runGit(args: string[], cwd: string): string | null {
  const gitBin = process.env.JARVIS_GIT_BIN || 'git';
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync([gitBin, '-C', cwd, ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
  } catch {
    // git binary missing or unspawnable — treat as "no git here".
    return null;
  }

  if (result.exitCode !== 0 || !result.stdout) {
    return null;
  }

  const text = result.stdout.toString().trim();
  return text || null;
}

// Use git's own probe instead of `existsSync('.git')` so linked worktrees
// (where `.git` is a file pointing into the main repo) and submodules
// resolve correctly. Falls through to package.json when git can't answer.
function isGitCheckout(packageRoot: string): boolean {
  return runGit(['rev-parse', '--git-dir'], packageRoot) !== null;
}

function stripLeadingV(s: string): string {
  return s.startsWith('v') ? s.slice(1) : s;
}

// `git describe --tags --always` falls back to a bare commit SHA in repos
// with no tags reachable from HEAD. Reject anything that doesn't look like
// a version so the package.json fallback wins instead of printing `abc1234`.
function looksLikeVersion(s: string): boolean {
  return /^v?\d+\.\d+/.test(s);
}

export function selectInstalledVersion(
  exactTag: string | null,
  describedVersion: string | null,
  packageVersion: string,
): string {
  if (exactTag) return stripLeadingV(exactTag);
  if (describedVersion) return stripLeadingV(describedVersion);
  return packageVersion;
}

export function getInstalledVersion(packageRoot: string): string {
  const pkgVersion = readPackageVersion(packageRoot);

  if (!isGitCheckout(packageRoot)) {
    return pkgVersion;
  }

  const exactTag = runGit(['describe', '--tags', '--exact-match'], packageRoot);
  if (exactTag) {
    return selectInstalledVersion(exactTag, null, pkgVersion);
  }

  const describedRaw = runGit(['describe', '--tags', '--always'], packageRoot);
  const described = describedRaw && looksLikeVersion(describedRaw) ? describedRaw : null;
  return selectInstalledVersion(null, described, pkgVersion);
}

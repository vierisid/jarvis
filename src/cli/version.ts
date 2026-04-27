import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'bun';

function readPackageVersion(packageRoot: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf-8')) as { version?: string };
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function runGit(args: string[], cwd: string): string | null {
  const gitBin = process.env.JARVIS_GIT_BIN || 'git';
  const result = spawnSync([gitBin, '-C', cwd, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  if (result.exitCode !== 0) {
    return null;
  }

  const text = result.stdout.toString().trim();
  return text || null;
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
  packageVersion: string,
  exactTag: string | null,
  describedVersion: string | null,
): string {
  if (exactTag) {
    return stripLeadingV(exactTag);
  }

  if (describedVersion) {
    return stripLeadingV(describedVersion);
  }

  return packageVersion;
}

export function getInstalledVersion(packageRoot: string): string {
  const pkgVersion = readPackageVersion(packageRoot);

  if (!existsSync(join(packageRoot, '.git'))) {
    return pkgVersion;
  }

  const exactTag = runGit(['describe', '--tags', '--exact-match'], packageRoot);
  if (exactTag) {
    return selectInstalledVersion(pkgVersion, exactTag, null);
  }

  const describedRaw = runGit(['describe', '--tags', '--always'], packageRoot);
  const described = describedRaw && looksLikeVersion(describedRaw) ? describedRaw : null;
  return selectInstalledVersion(pkgVersion, null, described);
}

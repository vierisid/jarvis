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

export function selectInstalledVersion(
  packageVersion: string,
  exactTag: string | null,
  describedVersion: string | null,
): string {
  if (exactTag) {
    return exactTag;
  }

  if (describedVersion) {
    return describedVersion;
  }

  return packageVersion;
}

export function getInstalledVersion(packageRoot: string): string {
  const pkgVersion = readPackageVersion(packageRoot);

  if (!existsSync(join(packageRoot, '.git'))) {
    return pkgVersion;
  }

  const exactTag = runGit(['describe', '--tags', '--exact-match'], packageRoot);
  const described = runGit(['describe', '--tags', '--always'], packageRoot);
  return selectInstalledVersion(pkgVersion, exactTag, described);
}

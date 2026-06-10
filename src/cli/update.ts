/**
 * `jarvis update` — install-method-aware updater.
 *
 * Dispatches based on how JARVIS was installed:
 *   docker      refuse, point user at host-side `docker pull`
 *   bun-global  `bun update -g @usejarvis/brain`
 *   script      checkout the latest release tag + bun install
 *   dev         refuse, tell user to `git pull` themselves
 *   unknown     refuse with guidance
 *
 * For docker/dev/unknown the command prints guidance and exits non-zero
 * rather than trying to guess — the wrong update path can silently bind
 * the user to stale code.
 */

import { join } from 'node:path';
import { openSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { c } from './helpers.ts';
import { isLocked, getLogPath } from '../daemon/pid.ts';
import { getInstalledVersion } from './version.ts';
import {
  detectInstallMethod,
  describeInstallMethod,
  type InstallMethod,
  type InstallMethodInfo,
} from './install-method.ts';
import { stopDaemonGracefully, type StopResult } from './daemon-control.ts';

export interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface Spawner {
  (cmd: string[], options?: { cwd?: string }): SpawnResult;
}

export interface UpdateDeps {
  packageRoot: string;
  /** Injectable for tests. Defaults to Bun.spawnSync wrapper. */
  spawn?: Spawner;
  /** Injectable for tests. Defaults to detectInstallMethod(). */
  detect?: (packageRoot: string) => InstallMethodInfo;
  /**
   * Injectable for tests. Defaults to reading the real lockfile — tests
   * must override to avoid stopping the developer's actual daemon.
   */
  checkRunning?: () => number | null;
  /** Injectable for tests. Defaults to real SIGTERM-based stop. */
  stopDaemon?: () => Promise<StopResult>;
  /**
   * Injectable for tests. Skips the detached restart when false so tests
   * can run without actually spawning a daemon.
   */
  restartDaemon?: boolean;
}

export interface UpdateResult {
  method: InstallMethod;
  outcome: 'updated' | 'up-to-date' | 'refused' | 'failed';
  /** Exit code the CLI should use. 0 for success/up-to-date. */
  exitCode: number;
  message: string;
}

function defaultSpawn(cmd: string[], options: { cwd?: string } = {}): SpawnResult {
  const result = Bun.spawnSync(cmd, {
    cwd: options.cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env },
  });
  return {
    exitCode: result.exitCode ?? -1,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

/**
 * Spawn the daemon in a detached process, same pattern as `jarvis start -d`.
 * Not in daemon-control.ts because it's update-specific: we only need to
 * restart after a successful update.
 */
function restartDaemonDetached(packageRoot: string): void {
  const logPath = getLogPath();
  const logFd = openSync(logPath, 'a');
  const child = spawn('bun', [join(packageRoot, 'bin/jarvis.ts'), 'start', '--no-open'], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env },
  });
  child.unref();
}

// ── Per-method handlers ─────────────────────────────────────────────

function updateDocker(info: InstallMethodInfo): UpdateResult {
  console.log(c.yellow('JARVIS is running inside a Docker container.'));
  console.log('');
  console.log('  `jarvis update` does not apply to container installs — the container is the unit of update.');
  console.log('  From your host, run:');
  console.log(c.dim('    docker pull <your-jarvis-image>'));
  console.log(c.dim('    docker rm -f jarvis && docker run -d ... <your-jarvis-image>'));
  console.log('');
  console.log(c.dim(`  (detected: ${info.reason})`));
  return {
    method: 'docker',
    outcome: 'refused',
    exitCode: 1,
    message: 'refused: docker install',
  };
}

function updateDev(info: InstallMethodInfo, packageRoot: string): UpdateResult {
  console.log(c.yellow('JARVIS is running from a developer checkout.'));
  console.log('');
  console.log('  `jarvis update` does not manage dev checkouts — updating your working tree');
  console.log('  would risk clobbering uncommitted work. Update manually:');
  console.log(c.dim(`    git -C ${packageRoot} pull`));
  console.log(c.dim(`    bun install`));
  console.log('');
  console.log(c.dim(`  (detected: ${info.reason})`));
  return {
    method: 'dev',
    outcome: 'refused',
    exitCode: 1,
    message: 'refused: dev checkout',
  };
}

function updateUnknown(info: InstallMethodInfo): UpdateResult {
  console.log(c.red('Could not determine how JARVIS was installed.'));
  console.log('');
  console.log('  `jarvis update` needs to know whether to run `bun update -g`, `git pull`,');
  console.log('  or redirect you to `docker pull`. Run `jarvis doctor` to see what was detected.');
  console.log('');
  console.log('  Update manually with one of:');
  console.log(c.dim('    bun update -g @usejarvis/brain              # if installed via bun'));
  console.log(c.dim('    curl -fsSL .../install.sh | bash             # if installed via the script'));
  console.log(c.dim('    docker pull <image>                          # if installed via docker'));
  console.log('');
  console.log(c.dim(`  (detected: ${info.reason})`));
  return {
    method: 'unknown',
    outcome: 'refused',
    exitCode: 1,
    message: 'refused: unknown install',
  };
}

function updateBunGlobal(
  currentVersion: string,
  spawn: Spawner,
): UpdateResult {
  console.log(c.dim('Running `bun update -g @usejarvis/brain`...\n'));

  const result = spawn(['bun', 'update', '-g', '@usejarvis/brain']);

  if (result.exitCode !== 0) {
    console.log(c.red('✗ Update failed:'));
    const err = result.stderr.trim() || result.stdout.trim();
    if (err) console.log(c.dim(`  ${err}`));
    return {
      method: 'bun-global',
      outcome: 'failed',
      exitCode: 1,
      message: 'bun update failed',
    };
  }

  // bun prints its own progress to stdout; relay it so the user sees what changed.
  const out = result.stdout.trim();
  if (out) console.log(out);

  return {
    method: 'bun-global',
    outcome: 'updated',
    exitCode: 0,
    message: `updated from ${currentVersion}`,
  };
}

/**
 * Compare two `vX.Y.Z` (or `vX.Y.Z.N`) tags numerically, component by
 * component. Returns >0 if `a` is newer, <0 if older, 0 if equal.
 */
function compareVersionTags(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Pick the highest version tag from `git ls-remote --tags --refs` output.
 * Mirrors install.sh's `grep -E '^v[0-9]…' | sort -V | tail -n1`. Returns
 * null when no version-shaped tag is present.
 */
export function pickLatestTag(lsRemoteStdout: string): string | null {
  const tags = lsRemoteStdout
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('refs/tags/');
      return idx === -1 ? null : line.slice(idx + 'refs/tags/'.length).trim();
    })
    .filter((t): t is string => !!t && /^v\d+(\.\d+)*$/.test(t));

  if (tags.length === 0) return null;
  return tags.reduce((best, cur) => (compareVersionTags(cur, best) > 0 ? cur : best));
}

function updateScript(
  packageRoot: string,
  currentVersion: string,
  spawn: Spawner,
): UpdateResult {
  // Script installs are pinned to a release tag (detached HEAD), so there is
  // no upstream branch to pull. Resolve the latest tag from the remote and
  // check it out instead. Mirrors install.sh's tag-pinning.
  const ls = spawn(['git', 'ls-remote', '--tags', '--refs', 'origin'], { cwd: packageRoot });
  if (ls.exitCode !== 0) {
    console.log(c.red('✗ Update failed (could not reach remote):'));
    const err = ls.stderr.trim() || ls.stdout.trim();
    if (err) console.log(c.dim(`  ${err}`));
    return { method: 'script', outcome: 'failed', exitCode: 1, message: 'git ls-remote failed' };
  }

  const latestTag = pickLatestTag(ls.stdout);
  if (!latestTag) {
    console.log(c.red('✗ Update failed: no release tags found on the remote.'));
    return { method: 'script', outcome: 'failed', exitCode: 1, message: 'no remote tags' };
  }

  // Already on the latest tag? `git describe --exact-match` prints the tag at
  // HEAD (and exits non-zero when HEAD isn't exactly on a tag — then we update).
  const describe = spawn(['git', 'describe', '--tags', '--exact-match'], { cwd: packageRoot });
  const currentTag = describe.exitCode === 0 ? describe.stdout.trim() : null;
  if (currentTag === latestTag) {
    console.log(c.green(`✓ Already on the latest version (${currentVersion})`));
    return { method: 'script', outcome: 'up-to-date', exitCode: 0, message: 'no-op' };
  }

  console.log(c.dim(`Updating to ${latestTag}...`));
  // Discard any local tracked changes so the checkout can't be blocked.
  spawn(['git', 'checkout', '--', '.'], { cwd: packageRoot });

  const fetch = spawn(
    ['git', 'fetch', '--depth', '1', 'origin', `refs/tags/${latestTag}:refs/tags/${latestTag}`],
    { cwd: packageRoot },
  );
  if (fetch.exitCode !== 0) {
    console.log(c.red('✗ Update failed (git fetch):'));
    const err = fetch.stderr.trim() || fetch.stdout.trim();
    if (err) console.log(c.dim(`  ${err}`));
    return { method: 'script', outcome: 'failed', exitCode: 1, message: 'git fetch failed' };
  }

  const checkout = spawn(['git', 'checkout', '-q', latestTag], { cwd: packageRoot });
  if (checkout.exitCode !== 0) {
    console.log(c.red('✗ Update failed (git checkout):'));
    const err = checkout.stderr.trim() || checkout.stdout.trim();
    if (err) console.log(c.dim(`  ${err}`));
    return { method: 'script', outcome: 'failed', exitCode: 1, message: 'git checkout failed' };
  }

  console.log(c.dim('Running `bun install`...'));
  const install = spawn(['bun', 'install'], { cwd: packageRoot });
  if (install.exitCode !== 0) {
    console.log(c.yellow('! Dependencies may need manual refresh:'));
    console.log(c.dim(`  cd ${packageRoot} && bun install`));
    // Don't fail the update — the checkout succeeded, dependencies are a
    // separate concern the user can resolve.
  }

  return {
    method: 'script',
    outcome: 'updated',
    exitCode: 0,
    message: `updated from ${currentVersion}`,
  };
}

// ── Orchestrator ────────────────────────────────────────────────────

export async function runUpdate(deps: UpdateDeps): Promise<UpdateResult> {
  const spawn = deps.spawn ?? defaultSpawn;
  const detect = deps.detect ?? detectInstallMethod;
  const restart = deps.restartDaemon ?? true;

  console.log(c.cyan('Checking for updates...\n'));

  const currentVersion = getInstalledVersion(deps.packageRoot);
  console.log(`  Current version: ${c.bold(currentVersion)}`);

  const info = detect(deps.packageRoot);
  console.log(`  Install method:  ${c.bold(describeInstallMethod(info))}`);
  console.log('');

  // Refusals — no daemon interaction needed.
  if (info.method === 'docker') return updateDocker(info);
  if (info.method === 'dev') return updateDev(info, deps.packageRoot);
  if (info.method === 'unknown') return updateUnknown(info);

  // Methods that actually update: stop daemon first, update, then restart.
  const checkRunning = deps.checkRunning ?? isLocked;
  const stopDaemon = deps.stopDaemon ?? (() => stopDaemonGracefully());
  const runningPid = checkRunning();
  if (runningPid) {
    console.log(c.dim(`  Stopping daemon (PID ${runningPid}) before update...`));
    await stopDaemon();
  }

  let result: UpdateResult;
  if (info.method === 'bun-global') {
    result = updateBunGlobal(currentVersion, spawn);
  } else {
    result = updateScript(deps.packageRoot, currentVersion, spawn);
  }

  if (result.outcome === 'updated') {
    const newVersion = getInstalledVersion(deps.packageRoot);
    if (newVersion === currentVersion) {
      console.log(c.green(`✓ Already on the latest version (${currentVersion})`));
    } else {
      console.log(c.green(`✓ Updated: ${currentVersion} → ${newVersion}`));
    }
  }

  if (runningPid && result.outcome !== 'failed' && restart) {
    console.log(c.dim('\nRestarting daemon...'));
    restartDaemonDetached(deps.packageRoot);
  }

  return result;
}

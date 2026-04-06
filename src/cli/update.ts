import { join } from 'node:path';
import { readFileSync, openSync, existsSync, mkdirSync, rmSync, cpSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { isLocked, releaseLock, getLogPath } from '../daemon/pid.ts';
import { c } from './helpers.ts';
import { setSetting } from '../vault/settings.ts';
import { initDatabase } from '../vault/schema.ts';
import { loadConfig } from '../config/loader.ts';

const PACKAGE_ROOT = join(import.meta.dir, '..', '..');
const CLI_ARGS = process.argv.slice(2);
const TARGET_VERSION_ARG = CLI_ARGS.find((arg) => arg.startsWith('--target-version='));
const TARGET_VERSION = TARGET_VERSION_ARG ? TARGET_VERSION_ARG.split('=')[1] : null;
const IS_DOCKER_ARG = CLI_ARGS.find((arg) => arg === '--in-docker');
const IS_IN_DOCKER = IS_DOCKER_ARG !== undefined;

function detectDocker(): boolean {
  if (existsSync('/.dockerenv')) return true;
  try {
    return readFileSync('/proc/1/cgroup', 'utf-8').includes('docker');
  } catch {
    return false;
  }
}

export function getJarvisVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf-8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function runGitCommand(args: string[]) {
  return Bun.spawnSync(['git', ...args], {
    cwd: PACKAGE_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });
}

function runGitCommandInDir(dir: string, args: string[]) {
  return Bun.spawnSync(['git', ...args], {
    cwd: dir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });
}

function hasGitRepo(): boolean {
  return existsSync(join(PACKAGE_ROOT, '.git'));
}

function ensureGitClean(): void {
  const status = runGitCommand(['status', '--porcelain']);
  if (status.exitCode !== 0) {
    throw new Error('Failed to check git status before updating.');
  }

  if (status.stdout.toString().trim()) {
    throw new Error('Local repository has uncommitted changes. Commit or stash them before updating.');
  }
}

function ensureUpstreamIsFastForwardable(): void {
  const branchResult = runGitCommand(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branchResult.exitCode !== 0) {
    throw new Error('Unable to determine current git branch before updating.');
  }

  const branch = branchResult.stdout.toString().trim();
  const upstreamResult = runGitCommand(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (upstreamResult.exitCode !== 0) {
    throw new Error(
      `Current branch '${branch}' has no upstream tracking branch. Set an upstream or update manually.`,
    );
  }

  const fetchResult = runGitCommand(['fetch', '--quiet']);
  if (fetchResult.exitCode !== 0) {
    throw new Error('Failed to fetch remote branches before updating.');
  }

  const divergenceResult = runGitCommand(['rev-list', '--left-right', '--count', 'HEAD...@{u}']);
  if (divergenceResult.exitCode !== 0) {
    throw new Error('Unable to compare local branch to upstream before updating.');
  }

  const divergence = divergenceResult.stdout.toString().trim().split('\t').map((value) => Number.parseInt(value, 10));
  const [behind, ahead] = divergence;
  if (Number.isNaN(behind) || Number.isNaN(ahead)) {
    throw new Error('Unexpected git divergence data before update.');
  }

  if (ahead > 0 && behind > 0) {
    throw new Error(
      `Local branch '${branch}' has diverged from upstream. Reconcile changes before updating.`,
    );
  }

  if (ahead > 0) {
    throw new Error(
      `Local branch '${branch}' is ahead of upstream by ${ahead} commit(s). Push or rebase before updating.`,
    );
  }
}

function resolveTargetTag(version: string): string {
  if (version.startsWith('v')) return version;
  return `v${version}`;
}

function copyDir(source: string, target: string): void {
  rmSync(target, { recursive: true, force: true });
  cpSync(source, target, { recursive: true });
}

function updateFromReleaseTag(version: string): void {
  const tempDir = join(tmpdir(), `jarvis-update-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });

  const cloneResult = runGitCommand(['clone', '--depth', '1', 'https://github.com/vierisid/jarvis.git', tempDir]);
  if (cloneResult.exitCode !== 0) {
    throw new Error('Failed to clone the official JARVIS repository for Docker update.');
  }

  const tag = resolveTargetTag(version);
  let checkoutResult = runGitCommandInDir(tempDir, ['checkout', '--detach', tag]);
  if (checkoutResult.exitCode !== 0) {
    const fallbackTag = version.startsWith('v') ? version.slice(1) : `v${version}`;
    checkoutResult = runGitCommandInDir(tempDir, ['checkout', '--detach', fallbackTag]);
  }

  if (checkoutResult.exitCode !== 0) {
    throw new Error(`Failed to checkout release tag '${version}' for Docker update.`);
  }

  const pathsToCopy = ['src', 'bin', 'roles', 'ui'];
  for (const path of pathsToCopy) {
    copyDir(join(tempDir, path), join(PACKAGE_ROOT, path));
  }

  for (const file of ['package.json', 'bun.lock', 'tsconfig.json', 'start.sh']) {
    const sourceFile = join(tempDir, file);
    if (existsSync(sourceFile)) {
      cpSync(sourceFile, join(PACKAGE_ROOT, file));
    }
  }

  rmSync(join(PACKAGE_ROOT, 'ui', 'dist'), { recursive: true, force: true });
}

export type JarvisUpdateResult = {
  previousVersion: string;
  currentVersion: string;
  changed: boolean;
};

function writeUpdateState(status: 'queued' | 'in_progress' | 'success' | 'error', message: string): void {
  setSetting('jarvis.update.status', status);
  setSetting('jarvis.update.message', message);
  setSetting('jarvis.update.updated_at', String(Date.now()));
}

export async function runJarvisUpdate(): Promise<JarvisUpdateResult> {
  console.log(c.cyan('Checking for updates...\n'));

  // Initialize database before writing any settings
  try {
    const config = await loadConfig();
    initDatabase(config.daemon.db_path);
  } catch (err) {
    console.warn(c.yellow(`  Warning: Could not initialize database: ${err}`));
    // Continue anyway - we'll try to update without database state tracking
  }

  const previousVersion = getJarvisVersion();
  console.log(`  Current version: ${c.bold(previousVersion)}`);

  writeUpdateState('in_progress', `Updating from ${previousVersion}...`);
  setSetting('jarvis.update.started_at', String(Date.now()));
  setSetting('jarvis.update.last_from_version', previousVersion);

  const wasRunning = isLocked();
  const inDocker = IS_IN_DOCKER || detectDocker();

  // In Docker, we don't need to stop the daemon - the container will restart anyway
  // For native installs, try to stop the daemon gracefully
  if (wasRunning && !inDocker) {
    console.log(c.dim('  Stopping daemon before update...'));
    try {
      process.kill(wasRunning, 'SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, 1000));
      releaseLock();
    } catch (err) {
      console.warn(c.yellow(`  Warning: Could not stop daemon: ${err}`));
      releaseLock();
    }
  } else if (wasRunning && inDocker) {
    console.log(c.dim('  Running in Docker — keeping current daemon session active (no in-place restart)'));
  }

  console.log('');

  if (inDocker && TARGET_VERSION) {
    console.log(c.dim('Running in Docker — using release update strategy'));
    updateFromReleaseTag(TARGET_VERSION);
  } else if (hasGitRepo()) {
    console.log(c.dim('Git repository detected — using git pull strategy'));
    ensureGitClean();
    ensureUpstreamIsFastForwardable();

    const gitPull = Bun.spawnSync(['git', 'pull', '--ff-only'], {
      cwd: PACKAGE_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    if (gitPull.exitCode !== 0) {
      const stderr = gitPull.stderr.toString();
      const installDir = join(require('node:os').homedir(), '.jarvis', 'daemon');
      const gitPullFallback = Bun.spawnSync(['git', 'pull', '--ff-only'], {
        cwd: installDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      if (gitPullFallback.exitCode !== 0) {
        const detail = gitPullFallback.stderr.toString().trim() || stderr.trim() || 'git pull failed';
        writeUpdateState('error', detail);
        if (wasRunning && !inDocker) {
          console.log(c.dim('\n  Restarting daemon...'));
          await restartAfterUpdate();
        }
        throw new Error(detail);
      }
    }
  } else {
    const dockerMsg = inDocker ? 'Docker mode detected but no target version provided.' : 'Not in Docker and no git repository found.';
    throw new Error(`Cannot update: ${dockerMsg}`);
  }

  const bunInstall = Bun.spawnSync(['bun', 'install'], {
    cwd: PACKAGE_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  if (bunInstall.exitCode !== 0) {
    console.log(c.yellow('! Dependencies may need manual refresh: bun install'));
  }

  const uiBuild = Bun.spawnSync(['bun', 'build', 'ui/index.html', '--outdir', 'ui/dist'], {
    cwd: PACKAGE_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  if (uiBuild.exitCode !== 0) {
    console.log(c.yellow('! UI build failed. Run `bun build ui/index.html --outdir ui/dist` manually if needed.'));
  }

  const currentVersion = getJarvisVersion();
  const changed = currentVersion !== previousVersion;

  if (changed) {
    console.log(c.green(`✓ Updated: ${previousVersion} → ${currentVersion}`));
  } else {
    console.log(c.green(`✓ Already on the latest version (${previousVersion})`));
  }

  writeUpdateState(
    'success',
    changed
      ? `Updated from ${previousVersion} to ${currentVersion}.`
      : `Already on the latest version (${currentVersion}).`,
  );
  setSetting('jarvis.update.last_to_version', currentVersion);
  setSetting('jarvis.update.completed_at', String(Date.now()));

  if (wasRunning && changed && !inDocker) {
    console.log(c.dim('\nRestarting daemon...'));
    await restartAfterUpdate();
  }

  return { previousVersion, currentVersion, changed };
}

async function restartAfterUpdate(): Promise<void> {
  const logPath = getLogPath();
  const logFd = openSync(logPath, 'a');
  const child = spawn('bun', ['bin/jarvis.ts', 'start', '--no-open'], {
    detached: true,
    cwd: PACKAGE_ROOT,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env },
  });
  child.unref();
  await new Promise((resolve) => setTimeout(resolve, 500));
}

if (import.meta.main) {
  try {
    await runJarvisUpdate();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeUpdateState('error', message);
    console.error(c.red(`✗ Update failed:`));
    console.error(c.dim(`  ${message}`));
    process.exit(1);
  }
}

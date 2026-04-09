import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { closeRL, ask, askYesNo, c } from './helpers.ts';
import { isLocked, releaseLock } from '../daemon/pid.ts';
import { getAutostartName, isAutostartInstalled, uninstallAutostart } from './autostart.ts';

const PACKAGE_ROOT = join(import.meta.dir, '..', '..');
const JARVIS_HOME = join(homedir(), '.jarvis');
const GLOBAL_BUN_ROOT = join(homedir(), '.bun', 'install', 'global');
const CLI_WRAPPER_CANDIDATES = [
  join(homedir(), '.bun', 'bin', 'jarvis'),
  join(homedir(), '.bun', 'bin', 'jarvis.cmd'),
  join(homedir(), '.bun', 'bin', 'jarvis.ps1'),
];

type CleanupPlan = {
  dataDir: string;
  packageRoot: string;
  removablePaths: string[];
  cliWrapperPaths: string[];
  bunPath: string;
  autostartInstalled: boolean;
};

function normalizePath(path: string): string {
  const resolved = resolve(path);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isWithinPath(candidate: string, parent: string): boolean {
  const normalizedCandidate = normalizePath(candidate);
  const normalizedParent = normalizePath(parent);
  return normalizedCandidate === normalizedParent || normalizedCandidate.startsWith(`${normalizedParent}${process.platform === 'win32' ? '\\' : '/'}`);
}

function uniqueSortedPaths(paths: string[]): string[] {
  const unique = Array.from(new Set(paths.map((path) => resolve(path))));
  return unique.sort((left, right) => right.length - left.length);
}

export function createCleanupPlan(packageRoot = PACKAGE_ROOT): CleanupPlan {
  const resolvedPackageRoot = resolve(packageRoot);
  const removablePaths = [JARVIS_HOME];

  if (isWithinPath(resolvedPackageRoot, GLOBAL_BUN_ROOT) || isWithinPath(resolvedPackageRoot, JARVIS_HOME)) {
    removablePaths.push(resolvedPackageRoot);
  }

  return {
    dataDir: JARVIS_HOME,
    packageRoot: resolvedPackageRoot,
    removablePaths: uniqueSortedPaths(removablePaths),
    cliWrapperPaths: CLI_WRAPPER_CANDIDATES.filter((path) => existsSync(path)),
    bunPath: Bun.which('bun') ?? 'bun',
    autostartInstalled: isAutostartInstalled(),
  };
}

export function buildCleanupScript(plan: CleanupPlan): string {
  const payload = JSON.stringify({
    removablePaths: plan.removablePaths,
    cliWrapperPaths: plan.cliWrapperPaths,
    bunPath: plan.bunPath,
  });

  return `import { rmSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const payload = ${payload};

function removePath(path) {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {}
}

function unlinkPath(path) {
  try {
    unlinkSync(path);
  } catch {
    removePath(path);
  }
}

await sleep(1500);

for (const wrapperPath of payload.cliWrapperPaths) {
  unlinkPath(wrapperPath);
}

try {
  spawnSync(payload.bunPath, ['uninstall', '-g', '@usejarvis/brain'], {
    stdio: 'ignore',
    env: { ...process.env },
  });
} catch {}

for (const target of payload.removablePaths) {
  removePath(target);
}
`;
}

async function stopDaemonIfRunning(): Promise<void> {
  const pid = isLocked();
  if (!pid) return;

  console.log(c.dim(`Stopping daemon (PID ${pid})...`));
  try {
    process.kill(pid, 'SIGTERM');

    let alive = true;
    for (let i = 0; i < 10; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
        break;
      }
    }

    if (alive) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
  } catch {}

  releaseLock();
}

async function scheduleCleanup(plan: CleanupPlan): Promise<void> {
  const tempDir = mkdtempSync(join(tmpdir(), 'jarvis-uninstall-'));
  const scriptPath = join(tempDir, 'cleanup.mjs');
  writeFileSync(scriptPath, buildCleanupScript(plan), 'utf-8');

  const child = spawn(plan.bunPath, [scriptPath], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env },
  });
  child.unref();
}

export async function runUninstallWizard(packageRoot = PACKAGE_ROOT): Promise<void> {
  const plan = createCleanupPlan(packageRoot);

  console.log(c.red('\nJARVIS Uninstall Wizard\n'));
  console.log('This will remove JARVIS from this machine.');
  console.log(c.dim('\nPlanned removal:'));
  console.log(c.dim(`  • Data directory: ${plan.dataDir}`));

  if (plan.autostartInstalled) {
    console.log(c.dim(`  • Autostart: ${getAutostartName()}`));
  }

  if (plan.cliWrapperPaths.length > 0) {
    for (const wrapperPath of plan.cliWrapperPaths) {
      console.log(c.dim(`  • CLI wrapper: ${wrapperPath}`));
    }
  }

  for (const target of plan.removablePaths) {
    if (target !== plan.dataDir) {
      console.log(c.dim(`  • Managed install: ${target}`));
    }
  }

  console.log(c.dim('\nSidecars are separate installs and will not be removed.\n'));

  const proceed = await askYesNo('Continue with complete uninstall?', false);
  if (!proceed) {
    console.log(c.yellow('\nUninstall cancelled.'));
    closeRL();
    return;
  }

  const confirmation = await ask('Type UNINSTALL to confirm');
  if (confirmation !== 'UNINSTALL') {
    console.log(c.yellow('\nConfirmation did not match. Uninstall cancelled.'));
    closeRL();
    return;
  }

  closeRL();

  await stopDaemonIfRunning();

  if (plan.autostartInstalled) {
    console.log(c.dim(`Removing ${getAutostartName()}...`));
    await uninstallAutostart();
  }

  await scheduleCleanup(plan);

  console.log(c.green('\nJARVIS uninstall scheduled.'));
  console.log(c.dim('Background cleanup will finish in a moment and remove the CLI wrapper.'));
}

/**
 * `jarvis uninstall` — install-method-aware uninstaller.
 *
 * Work is split into two phases:
 *   1. Side-effect cleanup runs synchronously in the parent process:
 *      stop the daemon, remove autostart. These touch things outside the
 *      package directory and can be done before the parent exits.
 *   2. Package removal runs in a detached child process: it waits for the
 *      parent to exit (so the CLI wrapper and package root are no longer
 *      being executed), then unlinks the wrapper, removes the package
 *      directory / runs `bun uninstall -g`, and removes the data dir.
 *
 * Branching by install method:
 *   docker      refuse — the container is the unit of uninstall
 *   bun-global  side-effect cleanup + detached `bun uninstall -g` + wrapper
 *   script      side-effect cleanup + detached rm -rf of package + data
 *   dev         side-effect cleanup only, leave source checkout alone
 *   unknown     side-effect cleanup only, print manual removal instructions
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { closeRL, ask, askYesNo, c } from './helpers.ts';
import { stopDaemonGracefully } from './daemon-control.ts';
import { getAutostartName, isAutostartInstalled, uninstallAutostart } from './autostart.ts';
import {
  detectInstallMethod,
  describeInstallMethod,
  type InstallMethod,
  type InstallMethodInfo,
} from './install-method.ts';

const PACKAGE_ROOT = join(import.meta.dir, '..', '..');

// ── Path resolution (respects env overrides) ─────────────────────────

export interface PlanOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  detect?: (packageRoot: string) => InstallMethodInfo;
}

function resolveDataDir(env: NodeJS.ProcessEnv, home: string): string {
  return env.JARVIS_HOME ? resolve(env.JARVIS_HOME) : join(home, '.jarvis');
}

function resolveWrapperCandidates(env: NodeJS.ProcessEnv, home: string): string[] {
  const bunRoot = env.BUN_INSTALL ? resolve(env.BUN_INSTALL) : join(home, '.bun');
  const bin = join(bunRoot, 'bin');
  return ['jarvis', 'jarvis.cmd', 'jarvis.ps1'].map((name) => join(bin, name));
}

function normalizePath(path: string): string {
  const r = resolve(path);
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

// ── Plan ─────────────────────────────────────────────────────────────

export interface CleanupPlan {
  method: InstallMethod;
  methodReason: string;
  dataDir: string;
  packageRoot: string;
  cliWrapperPaths: string[];
  bunPath: string;
  autostartInstalled: boolean;
  /** Paths the detached script will rm -rf. */
  removablePaths: string[];
  /** Only true for bun-global. */
  runBunUninstall: boolean;
  /** Where the detached script writes its log. Outside dataDir so it survives. */
  logPath: string;
}

export function createCleanupPlan(
  packageRoot = PACKAGE_ROOT,
  options: PlanOptions = {},
): CleanupPlan {
  const env = options.env ?? process.env;
  const home = options.homeDir ?? homedir();
  const detect = options.detect ?? detectInstallMethod;

  const resolvedPackageRoot = resolve(packageRoot);
  const dataDir = resolveDataDir(env, home);
  const info = detect(resolvedPackageRoot);
  const method = info.method;

  // What the detached script should remove, by method:
  //   script      → dataDir (includes packageRoot which is dataDir/daemon)
  //   bun-global  → dataDir only; `bun uninstall -g` removes the package itself
  //   docker      → nothing (we refuse earlier, but compute for completeness)
  //   dev         → dataDir only; never touch the dev checkout
  //   unknown     → dataDir only
  const removablePaths: string[] = [];
  if (method !== 'docker') {
    removablePaths.push(dataDir);
  }
  if (method === 'script') {
    // dataDir already covers resolvedPackageRoot at ~/.jarvis/daemon, so only
    // add it explicitly if the script install was placed somewhere outside
    // dataDir (shouldn't happen via the normal installer, but be defensive).
    const pr = normalizePath(resolvedPackageRoot);
    const dd = normalizePath(dataDir);
    const inside = pr === dd || pr.startsWith(dd + sep);
    if (!inside) removablePaths.push(resolvedPackageRoot);
  }

  return {
    method,
    methodReason: info.reason,
    dataDir,
    packageRoot: resolvedPackageRoot,
    cliWrapperPaths: resolveWrapperCandidates(env, home).filter((p) => existsSync(p)),
    bunPath: Bun.which('bun') ?? 'bun',
    autostartInstalled: isAutostartInstalled(),
    removablePaths: Array.from(new Set(removablePaths)),
    runBunUninstall: method === 'bun-global',
    // ~/.jarvis-uninstall.log sits next to, not inside, the data dir so it
    // survives the removal and is there for the user to inspect on failure.
    logPath: join(home, '.jarvis-uninstall.log'),
  };
}

// ── Detached cleanup script ─────────────────────────────────────────
//
// This is written to a temp file and spawned as a detached `bun` child. It
// must be self-contained — no imports from the JARVIS codebase, since the
// codebase is being deleted.

export function buildCleanupScript(plan: CleanupPlan): string {
  const payload = JSON.stringify({
    removablePaths: plan.removablePaths,
    cliWrapperPaths: plan.cliWrapperPaths,
    bunPath: plan.bunPath,
    runBunUninstall: plan.runBunUninstall,
    logPath: plan.logPath,
  });

  return `import { rmSync, unlinkSync, appendFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { dirname } from 'node:path';

const payload = ${payload};
const TEMP_DIR = dirname(process.argv[1]);

try {
  writeFileSync(payload.logPath, '');
} catch {}

function log(message) {
  try {
    appendFileSync(payload.logPath, '[' + new Date().toISOString() + '] ' + message + '\\n');
  } catch {}
}

async function unlinkWithRetry(path, attempts = 5, delayMs = 200) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      unlinkSync(path);
      return true;
    } catch (err) {
      if (err && err.code === 'ENOENT') return true;
      if (i === attempts - 1) {
        log('failed to unlink ' + path + ': ' + String(err));
        return false;
      }
      await sleep(delayMs * (i + 1));
    }
  }
  return false;
}

async function removePath(path) {
  try {
    rmSync(path, { recursive: true, force: true });
    return true;
  } catch (err) {
    log('failed to remove ' + path + ': ' + String(err));
    return false;
  }
}

log('cleanup started (pid=' + process.pid + ')');

// Give the parent jarvis CLI 1.5s to fully exit and release the wrapper /
// package directory. Windows holds file handles on executing binaries, so
// without this wait wrapper unlink and package rm both fail.
await sleep(1500);

for (const wrapperPath of payload.cliWrapperPaths) {
  const ok = await unlinkWithRetry(wrapperPath);
  log((ok ? 'unlinked wrapper ' : 'failed wrapper ') + wrapperPath);
}

if (payload.runBunUninstall) {
  try {
    const r = spawnSync(payload.bunPath, ['uninstall', '-g', '@usejarvis/brain'], {
      stdio: 'pipe',
      env: { ...process.env },
    });
    log('bun uninstall -g exit=' + r.status);
  } catch (err) {
    log('bun uninstall -g threw: ' + String(err));
  }
}

for (const target of payload.removablePaths) {
  const ok = await removePath(target);
  log((ok ? 'removed ' : 'failed ') + target);
}

log('cleanup complete');

// Self-destruct our own temp dir so tmpdir() doesn't accumulate
// jarvis-uninstall-* directories across repeated uninstall attempts.
try {
  rmSync(TEMP_DIR, { recursive: true, force: true });
} catch {}
`;
}

// ── Side-effect cleanup (synchronous, parent process) ───────────────

async function runSideEffectCleanup(plan: CleanupPlan): Promise<void> {
  await stopDaemonGracefully({
    onStart: (pid) => console.log(c.dim(`Stopping daemon (PID ${pid})...`)),
    onForce: (pid) => console.log(c.dim(`Force-killing daemon (PID ${pid})...`)),
  });

  if (plan.autostartInstalled) {
    console.log(c.dim(`Removing ${getAutostartName()}...`));
    try {
      await uninstallAutostart();
    } catch (err) {
      // Autostart removal can fail if systemd/launchd is in a weird state.
      // Surface the error but don't abort — the user still wants the rest
      // of the uninstall to proceed.
      console.log(c.yellow(`  ! Autostart removal failed: ${String(err).slice(0, 120)}`));
      console.log(c.dim(`    You may need to remove it manually.`));
    }
  }
}

// ── Package removal (detached process) ──────────────────────────────

async function schedulePackageRemoval(plan: CleanupPlan): Promise<void> {
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

// ── Orchestrator ────────────────────────────────────────────────────

function printPlan(plan: CleanupPlan): void {
  console.log(c.red('\nJARVIS Uninstall Wizard\n'));
  console.log(`  Install method: ${c.bold(describeInstallMethod({ method: plan.method, reason: plan.methodReason }))}`);
  console.log(c.dim(`  (${plan.methodReason})`));
  console.log('');
  console.log(c.dim('Planned cleanup:'));
  console.log(c.dim(`  • Stop daemon (if running)`));
  if (plan.autostartInstalled) {
    console.log(c.dim(`  • Remove autostart: ${getAutostartName()}`));
  }
  for (const target of plan.removablePaths) {
    console.log(c.dim(`  • Remove: ${target}`));
  }
  for (const wrapperPath of plan.cliWrapperPaths) {
    console.log(c.dim(`  • Remove CLI wrapper: ${wrapperPath}`));
  }
  if (plan.runBunUninstall) {
    console.log(c.dim(`  • Run: bun uninstall -g @usejarvis/brain`));
  }
  if (plan.method === 'dev') {
    console.log(c.dim(`  • Developer checkout at ${plan.packageRoot} will be LEFT IN PLACE.`));
  }
  if (plan.method === 'unknown') {
    console.log(c.dim(`  • Package at ${plan.packageRoot} will be LEFT IN PLACE (install method unknown).`));
    console.log(c.dim(`    Remove it manually with your package manager.`));
  }
  console.log(c.dim(`\nSidecars are separate installs and will not be removed.`));
  console.log(c.dim(`Cleanup log: ${plan.logPath}\n`));
}

function refuseDocker(plan: CleanupPlan): void {
  console.log(c.yellow('\nJARVIS is running inside a Docker container.\n'));
  console.log('  `jarvis uninstall` does not apply to container installs — the');
  console.log('  container is the unit of uninstall.');
  console.log('');
  console.log('  From your host, run:');
  console.log(c.dim('    docker rm -f jarvis'));
  console.log(c.dim('    docker volume rm jarvis-data   # if you want to delete data too'));
  console.log('');
  console.log(c.dim(`  (detected: ${plan.methodReason})`));
}

export async function runUninstallWizard(packageRoot = PACKAGE_ROOT): Promise<void> {
  const plan = createCleanupPlan(packageRoot);

  // Docker guardrail comes before any prompts — running this inside a
  // container is almost always a mistake.
  if (plan.method === 'docker') {
    refuseDocker(plan);
    return;
  }

  printPlan(plan);

  const proceed = await askYesNo('Continue with uninstall?', false);
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

  await runSideEffectCleanup(plan);

  if (plan.method === 'dev' || plan.method === 'unknown') {
    console.log(c.green('\n✓ Side-effect cleanup complete.'));
    if (plan.method === 'dev') {
      console.log(c.dim(`  Your dev checkout at ${plan.packageRoot} is untouched.`));
    } else {
      console.log(c.dim(`  Remove the package at ${plan.packageRoot} manually with your package manager.`));
    }
    return;
  }

  await schedulePackageRemoval(plan);

  console.log(c.green('\n✓ Uninstall scheduled.'));
  console.log(c.dim(`  Background cleanup will finish shortly. See ${plan.logPath} if anything fails.`));
}

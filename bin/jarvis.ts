#!/usr/bin/env bun
/**
 * J.A.R.V.I.S. CLI Entry Point
 *
 * Usage:
 *   jarvis start [--port N] [-d|--detach]   Start the daemon
 *   jarvis stop [--port N]                  Stop the running daemon (graceful drain)
 *   jarvis drain [--port N]                 Graceful drain + stop (finish in-flight work)
 *   jarvis status                           Show daemon status
 *   jarvis uninstall                        Remove JARVIS (detects install method)
 *   jarvis doctor                           Check environment & connectivity
 *   jarvis version                          Print version
 *   jarvis help                             Show this help
 *
 * First-time setup happens in the dashboard at http://localhost:3142
 * after `jarvis start` — there is no longer a CLI wizard.
 */

import { join } from 'node:path';
import { existsSync, openSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { acquireLock, releaseLock, isLocked, getLogPath } from '../src/daemon/pid.ts';
import { c } from '../src/cli/helpers.ts';
import { ensurePortReleased, getConfiguredPort, resolveStopPort } from '../src/cli/lifecycle.ts';
import { getInstalledVersion } from '../src/cli/version.ts';
import { loadConfig } from '../src/config/loader.ts';

const PACKAGE_ROOT = join(import.meta.dir, '..');

function getVersion(): string {
  return getInstalledVersion(PACKAGE_ROOT);
}

function printHelp(): void {
  console.log(`
${c.cyan('J.A.R.V.I.S.')} ${c.dim(`v${getVersion()}`)}
Just A Rather Very Intelligent System

${c.bold('Usage:')}
  jarvis <command> [options]

${c.bold('Commands:')}
  ${c.cyan('start')}     Start the JARVIS daemon
  ${c.cyan('stop')}      Stop the running daemon
  ${c.cyan('restart')}   Restart the daemon (stop + start)
  ${c.cyan('status')}    Show daemon status
  ${c.cyan('logs')}      Tail the daemon log file
  ${c.cyan('update')}    Update JARVIS (dispatches based on install method)
  ${c.cyan('uninstall')} Remove JARVIS (dispatches based on install method)
  ${c.cyan('doctor')}    Check environment and connectivity
  ${c.cyan('enroll')}    Enroll a sidecar device: mint + store its JWT (no daemon needed)
  ${c.cyan('sidecars')}  List enrolled devices (sidecars list [--json])
  ${c.cyan('revoke')}    Revoke an enrolled device by sid
  ${c.cyan('export')}    Export user data as a tar archive (export [--out <path>|-] [--full])
  ${c.cyan('restore')}   Restore user data from an export archive (restore <archive|->)
  ${c.cyan('version')}   Print version number
  ${c.cyan('help')}      Show this help message

${c.bold('Start options:')}
  --port <N>        Override daemon port (default: 3142)
  -d, --detach      Run as background daemon
  --no-open         Don't auto-open dashboard in browser
  --data-dir <path> Override data directory (default: ~/.jarvis)
  --no-local-tools  Disable local tool execution (Docker/headless mode)

${c.bold('Logs options:')}
  -f, --follow      Follow log output (like tail -f)
  -n, --lines <N>   Number of lines to show (default: 50)

${c.bold('Examples:')}
  jarvis start                  Start in foreground
  jarvis start -d               Start as background daemon
  jarvis start --port 8080      Start on custom port
  jarvis restart                Restart with same settings
  jarvis logs -f                Follow live log output
  jarvis update                 Update to latest version
  jarvis uninstall              Remove JARVIS from this machine
  jarvis enroll "desktop-NA23"  Mint an enrollment token for a device
  jarvis enroll <name> --rotate Re-enroll invalidating all previous tokens
  jarvis sidecars list --json   List devices (machine-readable)
  jarvis revoke <sid>           Revoke a device's access
  jarvis doctor                 Check if everything is working
`);
}

function assertSupportedPlatform(): void {
  if (process.platform !== 'win32') return;
  console.error(c.red('Native Windows installs are not supported for the JARVIS daemon.'));
  console.error(c.dim('Use WSL2 for the Bun install, or run JARVIS with Docker on Windows.'));
  console.error(c.dim('The Windows sidecar is still supported separately.'));
  process.exit(1);
}

async function cmdStart(args: string[]): Promise<void> {
  const detach = args.includes('--detach') || args.includes('-d');
  const noOpen = args.includes('--no-open');
  const noLocalTools = args.includes('--no-local-tools');

  // Parse --port
  let port: number | undefined;
  const portIdx = args.indexOf('--port');
  if (portIdx !== -1 && args[portIdx + 1]) {
    port = parseInt(args[portIdx + 1]!, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      console.error(c.red('Error: --port requires a number between 1 and 65535'));
      process.exit(1);
    }
  }

  // Parse --data-dir
  let dataDir: string | undefined;
  const dataDirIdx = args.indexOf('--data-dir');
  if (dataDirIdx !== -1 && args[dataDirIdx + 1]) {
    dataDir = args[dataDirIdx + 1]!;
  }

  // Friendly first-run hint — when no config exists yet, the daemon
  // boots in "setup mode" and the dashboard's onboarding gate handles
  // LLM/TTS/profile/tutorial. Print a one-liner so the user knows where
  // to go (the browser auto-opens too unless --no-open is set).
  const { existsSync: _exists } = await import('node:fs');
  const { homedir } = await import('node:os');
  const cfgPath = join(homedir(), '.jarvis', 'config.yaml');
  if (!_exists(cfgPath)) {
    console.log(c.cyan('First-run detected. Jarvis is JWT-only by default:'));
    console.log(c.dim('  1. jarvis enroll "<device-name>"   mint your device token'));
    console.log(c.dim('  2. paste the token into the sidecar (desktop app) to connect'));
    console.log(c.dim('  Setting up without a sidecar? Put "auth:\n  insecure_open_access: true"'));
    console.log(c.dim(`  in ~/.jarvis/config.yaml, open http://localhost:${port ?? 3142}, and`));
    console.log(c.dim('  REMOVE the flag once your device is enrolled.'));
    console.log('');
  }

  if (!detach) {
    // Run in foreground — acquire lock atomically (checks + locks in one step)
    if (!acquireLock(process.pid)) {
      console.log(c.yellow('JARVIS is already running'));
      console.log(c.dim('  Stop it first with: jarvis stop'));
      process.exit(1);
    }
    // Release the flock on final exit. Do NOT handle SIGINT/SIGTERM here: the
    // daemon (src/daemon/index.ts) traps them and runs a bounded graceful
    // DRAIN before exiting. A `process.exit(0)` from the CLI would preempt that
    // async teardown mid-flight. The OS auto-releases the flock on exit anyway.
    process.on('exit', () => releaseLock());

    const { startDaemon } = await import('../src/daemon/index.ts');
    await startDaemon({ port, dataDir, noLocalTools });

    if (!noOpen) {
      openDashboard(port ?? 3142);
    }
  } else {
    // Check if already running before spawning detached child
    const existingPid = isLocked();
    if (existingPid) {
      console.log(c.yellow(`JARVIS is already running (PID ${existingPid})`));
      console.log(c.dim('  Stop it first with: jarvis stop'));
      process.exit(1);
    }

    // Run in background — spawn a detached child process with log file
    console.log(c.cyan('Starting J.A.R.V.I.S. daemon...'));

    const logPath = getLogPath();
    const logFile = Bun.file(logPath);

    const daemonArgs = [join(PACKAGE_ROOT, 'bin/jarvis.ts'), 'start', '--no-open'];
    if (port) daemonArgs.push('--port', String(port));

    const logFd = openSync(logPath, 'a');
    const child = spawn('bun', daemonArgs, {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env },
    });
    child.unref();

    // Poll for the daemon to acquire its lock (up to 10s)
    let runningPid: number | null = null;
    for (let i = 0; i < 20; i++) {
      await new Promise(resolve => setTimeout(resolve, 500));
      runningPid = isLocked();
      if (runningPid) break;
    }

    if (runningPid) {
      console.log(c.green(`✓ JARVIS daemon started (PID ${runningPid})`));
      console.log(c.dim(`  Dashboard: http://localhost:${port ?? 3142}`));
      console.log(c.dim(`  Logs:      ${logPath}`));
      console.log(c.dim(`  Stop with: jarvis stop`));

      if (!noOpen) {
        openDashboard(port ?? 3142);
      }
    } else {
      console.log(c.red('✗ Failed to start daemon. Check logs:'));
      console.log(c.dim(`  ${logPath}`));
      process.exit(1);
    }
  }
}

async function cmdStop(args: string[] = [], opts: { verb?: string } = {}): Promise<void> {
  const verb = opts.verb ?? 'Stopping';
  const pid = isLocked();

  // Parse `--port N` for the no-lockfile recovery path. Ignored when the
  // lockfile recorded the daemon's actual port (authoritative).
  let cliPort: number | undefined;
  const portIdx = args.indexOf('--port');
  if (portIdx !== -1 && args[portIdx + 1]) {
    const parsed = parseInt(args[portIdx + 1]!, 10);
    if (isNaN(parsed) || parsed < 1 || parsed > 65535) {
      console.error(c.red('Error: --port requires a number between 1 and 65535'));
      process.exit(1);
    }
    cliPort = parsed;
  }

  const resolution = resolveStopPort({ cliPort });
  const port = resolution.port;
  if (port !== null && resolution.source !== 'lockfile' && resolution.source !== 'default') {
    console.log(c.dim(`  Using port ${port} (from ${resolution.source})`));
  }
  if (port === null) {
    console.log(c.dim('  Unix-socket mode (daemon.listen) — pid-only stop, no port cleanup'));
  }

  if (!pid) {
    if (port === null) {
      console.log(c.yellow('JARVIS is not running.'));
      return;
    }
    const cleanup = await ensurePortReleased(port);
    if (cleanup.terminated.length > 0 || cleanup.forced.length > 0) {
      const details = cleanup.forced.length > 0
        ? ` Force-killed lingering listener(s) on port ${port}: ${cleanup.forced.join(', ')}.`
        : ` Cleaned up lingering listener(s) on port ${port}: ${cleanup.terminated.join(', ')}.`;
      console.log(c.green(`✓ JARVIS was not locked, but the port is now clear.${details}`));
    } else {
      console.log(c.yellow('JARVIS is not running.'));
    }
    return;
  }

  console.log(c.cyan(`${verb} JARVIS daemon (PID ${pid})...`));
  try {
    process.kill(pid, 'SIGTERM');

    // SIGTERM triggers a BOUNDED graceful drain in the daemon (finish in-flight
    // turns/workflows within the deadline). Poll until it exits -- an idle
    // daemon exits near-instantly; a busy one drains first. SIGKILL only if it
    // overruns its own drain deadline (+ margin).
    const cfg = await loadConfig().catch(() => null);
    const graceMs = (cfg?.daemon?.drain_deadline_ms ?? 75_000) + 20_000;
    const deadline = Date.now() + graceMs;
    let alive = true;
    let ticks = 0;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 500));
      try { process.kill(pid, 0); } catch { alive = false; break; }
      if (++ticks === 6) console.log(c.dim('  Draining in-flight work...'));
    }

    if (alive) {
      console.log(c.dim('  Drain deadline exceeded, sending SIGKILL...'));
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }

    if (port === null) {
      releaseLock();
      console.log(c.green('✓ JARVIS daemon stopped.'));
      return;
    }
    const cleanup = await ensurePortReleased(port);
    releaseLock();
    if (!cleanup.released) {
      console.error(c.red(`✗ JARVIS stopped but port ${port} is still occupied.`));
      process.exit(1);
    }

    const details = cleanup.forced.length > 0
      ? ` Force-killed lingering listener(s) on port ${port}: ${cleanup.forced.join(', ')}.`
      : cleanup.terminated.length > 0
        ? ` Cleaned up lingering listener(s) on port ${port}: ${cleanup.terminated.join(', ')}.`
        : '';
    console.log(c.green(`✓ JARVIS daemon stopped.${details}`));
  } catch (err) {
    console.error(c.red(`Failed to stop process ${pid}: ${err}`));
    releaseLock();
  }
}

function cmdStatus(): void {
  const pid = isLocked();
  if (pid) {
    console.log(`${c.green('●')} JARVIS is ${c.green('running')} (PID ${pid})`);

    // Try to read the port from config
    try {
      const port = getConfiguredPort();
      console.log(c.dim(`  Dashboard: http://localhost:${port}`));
    } catch {
      console.log(c.dim(`  Dashboard: http://localhost:3142`));
    }

    console.log(c.dim(`  Stop with: jarvis stop`));
  } else {
    console.log(`${c.red('●')} JARVIS is ${c.red('stopped')}`);
    console.log(c.dim(`  Start with: jarvis start`));
  }
}

async function cmdDoctor(): Promise<void> {
  const { runDoctor } = await import('../src/cli/doctor.ts');
  await runDoctor();
}

async function cmdUninstall(): Promise<void> {
  const { runUninstallWizard } = await import('../src/cli/uninstall.ts');
  await runUninstallWizard(PACKAGE_ROOT);
}

async function cmdRestart(args: string[]): Promise<void> {
  const pid = isLocked();
  if (pid) {
    await cmdStop();
  }

  console.log('');
  await cmdStart(args);
}

function cmdLogs(args: string[]): void {
  const logPath = getLogPath();

  if (!existsSync(logPath)) {
    console.log(c.yellow('No log file found. Start the daemon first: jarvis start'));
    return;
  }

  const follow = args.includes('-f') || args.includes('--follow');

  // Parse --lines / -n
  let lines = 50;
  const nIdx = args.indexOf('-n') !== -1 ? args.indexOf('-n') : args.indexOf('--lines');
  if (nIdx !== -1 && args[nIdx + 1]) {
    const n = parseInt(args[nIdx + 1], 10);
    if (!isNaN(n) && n > 0) lines = n;
  }

  console.log(c.dim(`Log file: ${logPath}\n`));

  if (follow) {
    // tail -f equivalent
    const tailProc = Bun.spawn(['tail', '-f', '-n', String(lines), logPath], {
      stdio: ['ignore', 'inherit', 'inherit'],
    });

    process.on('SIGINT', () => {
      tailProc.kill();
      process.exit(0);
    });
  } else {
    // Just show last N lines
    const tailProc = Bun.spawnSync(['tail', '-n', String(lines), logPath]);
    process.stdout.write(tailProc.stdout);
  }
}

async function cmdUpdate(): Promise<void> {
  const { runUpdate } = await import('../src/cli/update.ts');
  const result = await runUpdate({ packageRoot: PACKAGE_ROOT });
  if (result.exitCode !== 0) {
    process.exit(result.exitCode);
  }
}

function openDashboard(port: number): void {
  const url = `http://localhost:${port}`;
  try {
    const platform = process.platform;
    if (platform === 'darwin') {
      Bun.spawn(['open', url], { stdio: ['ignore', 'ignore', 'ignore'] });
    } else {
      // Check WSL first
      const { readFileSync } = require('node:fs');
      try {
        const version = readFileSync('/proc/version', 'utf-8');
        if (version.toLowerCase().includes('microsoft')) {
          Bun.spawn(['wslview', url], { stdio: ['ignore', 'ignore', 'ignore'] });
          return;
        }
      } catch {}
      // Regular Linux
      Bun.spawn(['xdg-open', url], { stdio: ['ignore', 'ignore', 'ignore'] });
    }
  } catch {
    // Silently fail — user can open manually
  }
}

// ── Main ─────────────────────────────────────────────────────────────

assertSupportedPlatform();

const args = process.argv.slice(2);
const command = args[0] || 'help';
const commandArgs = args.slice(1);

switch (command) {
  case 'start':
    await cmdStart(commandArgs);
    break;
  case 'stop':
    await cmdStop(commandArgs);
    break;
  case 'drain':
    // Same signal as stop (SIGTERM -> bounded graceful drain); clearer label.
    await cmdStop(commandArgs, { verb: 'Draining' });
    break;
  case 'restart':
    await cmdRestart(commandArgs);
    break;
  case 'status':
    cmdStatus();
    break;
  case 'logs':
  case 'log':
    cmdLogs(commandArgs);
    break;
  case 'update':
  case 'upgrade':
    await cmdUpdate();
    break;
  case 'onboard':
    console.log(c.yellow('The CLI onboarding wizard has been retired.'));
    console.log(c.dim('  First-time setup now happens in the dashboard:'));
    console.log(c.dim('    1. Run: jarvis start'));
    console.log(c.dim('    2. Open: http://localhost:3142'));
    console.log(c.dim('  The dashboard guides you through LLM, voice, and profile setup.'));
    break;
  case 'doctor':
    await cmdDoctor();
    break;
  case 'enroll': {
    const { cmdEnroll } = await import('../src/cli/devices.ts');
    process.exit(await cmdEnroll(commandArgs));
  }
  case 'sidecars': {
    const { cmdSidecars } = await import('../src/cli/devices.ts');
    process.exit(await cmdSidecars(commandArgs));
  }
  case 'revoke': {
    const { cmdRevoke } = await import('../src/cli/devices.ts');
    process.exit(await cmdRevoke(commandArgs));
  }
  case 'export': {
    const { cmdExport } = await import('../src/cli/backup.ts');
    process.exit(await cmdExport(commandArgs));
  }
  case 'restore': {
    const { cmdRestore } = await import('../src/cli/backup.ts');
    process.exit(await cmdRestore(commandArgs));
  }
  case 'uninstall':
    await cmdUninstall();
    break;
  case 'version':
  case '-v':
  case '--version':
    console.log(`v${getVersion()}`);
    break;
  case 'help':
  case '-h':
  case '--help':
    printHelp();
    break;
  default:
    console.error(c.red(`Unknown command: ${command}`));
    console.log(c.dim('Run "jarvis help" for usage information.'));
    process.exit(1);
}

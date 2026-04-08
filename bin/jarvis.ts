#!/usr/bin/env bun
/**
 * J.A.R.V.I.S. CLI Entry Point
 *
 * Usage:
 *   jarvis start [--port N] [-d|--detach]   Start the daemon
 *   jarvis stop                             Stop the running daemon
 *   jarvis status                           Show daemon status
 *   jarvis onboard                          Interactive setup wizard
 *   jarvis doctor                           Check environment & connectivity
 *   jarvis version                          Print version
 *   jarvis help                             Show this help
 */

import { join } from 'node:path';
import { readFileSync, existsSync, openSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { acquireLock, releaseLock, isLocked, getLogPath } from '../src/daemon/pid.ts';
import { c } from '../src/cli/helpers.ts';
import { getJarvisVersion, runJarvisUpdate } from '../src/cli/update.ts';

const PACKAGE_ROOT = join(import.meta.dir, '..');

function getVersion(): string {
  return getJarvisVersion();
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
  ${c.cyan('update')}    Update JARVIS to the latest version
  ${c.cyan('onboard')}   Interactive first-time setup wizard
  ${c.cyan('doctor')}    Check environment and connectivity
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
  jarvis onboard                Run the setup wizard
  jarvis doctor                 Check if everything is working
`);
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

  if (!detach) {
    // Run in foreground — acquire lock atomically (checks + locks in one step)
    if (!acquireLock(process.pid)) {
      console.log(c.yellow('JARVIS is already running'));
      console.log(c.dim('  Stop it first with: jarvis stop'));
      process.exit(1);
    }
    process.on('exit', () => releaseLock());
    process.on('SIGINT', () => { releaseLock(); process.exit(0); });
    process.on('SIGTERM', () => { releaseLock(); process.exit(0); });

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

async function cmdStop(): Promise<void> {
  const pid = isLocked();
  if (!pid) {
    console.log(c.yellow('JARVIS is not running.'));
    return;
  }

  console.log(c.cyan(`Stopping JARVIS daemon (PID ${pid})...`));
  try {
    process.kill(pid, 'SIGTERM');

    // Wait up to 5s for graceful shutdown, then SIGKILL
    let alive = true;
    for (let i = 0; i < 10; i++) {
      await new Promise(resolve => setTimeout(resolve, 500));
      try { process.kill(pid, 0); } catch { alive = false; break; }
    }

    if (alive) {
      console.log(c.dim('  Process still alive, sending SIGKILL...'));
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }

    releaseLock();
    console.log(c.green('✓ JARVIS daemon stopped.'));
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
      const { homedir } = require('node:os');
      const configPath = join(homedir(), '.jarvis', 'config.yaml');
      const YAML = require('yaml');
      const text = readFileSync(configPath, 'utf-8');
      const cfg = YAML.parse(text);
      const port = cfg?.daemon?.port ?? 3142;
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

async function cmdOnboard(): Promise<void> {
  const { runOnboard } = await import('../src/cli/onboard.ts');
  await runOnboard();
}

async function cmdDoctor(): Promise<void> {
  const { runDoctor } = await import('../src/cli/doctor.ts');
  await runDoctor();
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
  try {
    await runJarvisUpdate();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(c.red('✗ Update failed:'));
    console.log(c.dim(`  ${message}`));
    process.exit(1);
  }
}

function openDashboard(port: number): void {
  const url = `http://localhost:${port}`;
  try {
    const platform = process.platform;
    if (platform === 'darwin') {
      // macOS: use 'open' command
      Bun.spawn(['open', url], { stdio: ['ignore', 'ignore', 'ignore'] });
    } else if (platform === 'win32') {
      // Windows: use 'start' command (CMD.exe)
      Bun.spawn(['cmd', '/c', `start ${url}`], { stdio: ['ignore', 'ignore', 'ignore'] });
    } else {
      // Linux: check for WSL first, then fall back to xdg-open
      const { readFileSync } = require('node:fs');
      try {
        const version = readFileSync('/proc/version', 'utf-8');
        if (version.toLowerCase().includes('microsoft')) {
          // WSL: use wslview to open in Windows browser
          Bun.spawn(['wslview', url], { stdio: ['ignore', 'ignore', 'ignore'] });
          return;
        }
      } catch {}
      // Regular Linux: use xdg-open
      Bun.spawn(['xdg-open', url], { stdio: ['ignore', 'ignore', 'ignore'] });
    }
  } catch {
    // Silently fail — user can open manually
  }
}

// ── Main ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0] || 'help';
const commandArgs = args.slice(1);

switch (command) {
  case 'start':
    await cmdStart(commandArgs);
    break;
  case 'stop':
    await cmdStop();
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
    await cmdOnboard();
    break;
  case 'doctor':
    await cmdDoctor();
    break;
  case 'version':
  case '-v':
  case '--version':
    console.log(getVersion());
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

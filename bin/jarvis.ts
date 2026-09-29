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
 * First-time setup happens in the dashboard after `jarvis start` - there is no
 * longer a CLI wizard. `jarvis start` prints its URL, which follows the port the
 * daemon binds (resolveDashboardTarget), not a fixed one.
 */

import { join } from 'node:path';
import { existsSync, openSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { acquireLock, releaseLock, releaseLockIfUnheld, isLocked, getLogPath, isProcessAlive, waitForProcessExit } from '../src/daemon/pid.ts';
import { c } from '../src/cli/helpers.ts';
import { describeDashboard, ensurePortReleased, resolveDashboardTarget, resolveStopPort } from '../src/cli/lifecycle.ts';
import { getInstalledVersion } from '../src/cli/version.ts';
import { loadConfig } from '../src/config/loader.ts';
import { modelExecCliWarning } from '../src/util/model-exec-marker.ts';

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
  --no-local-tools  Run the general tools only on a sidecar (your machine), never
                    on this host (Docker/headless). The site builder still runs here.

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

  // Where the dashboard will be, resolved ONCE for every place below that
  // prints or opens it: the hint, the detached summary, and openDashboard on
  // both paths. It follows the port startDaemon is about to bind rather than a
  // hardcoded 3142 (#544), and has no URL at all in unix-socket mode.
  const dashboard = describeDashboard(resolveDashboardTarget({ cliPort: port }));

  // Friendly first-run hint - when no config exists yet, the daemon
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
    console.log(c.dim(dashboard.openUrl
      ? `  in ~/.jarvis/config.yaml, open ${dashboard.openUrl}, and`
      : '  in ~/.jarvis/config.yaml, reach the socket in daemon.listen through your proxy, and'));
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

    if (!noOpen && dashboard.openUrl) {
      openDashboard(dashboard.openUrl);
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

    const daemonArgs = [join(PACKAGE_ROOT, 'bin/jarvis.ts'), 'start', '--no-open'];
    if (port) daemonArgs.push('--port', String(port));

    // We redirect the child's stdout AND stderr into logPath. If
    // daemon.log_file_path names this same file the child does NOT install its
    // in-process sink on top: it fstats fds 1/2 against the configured path and
    // skips (src/daemon/index.ts). That check lives in the daemon rather than
    // here because it is the only place that covers every launcher - this one,
    // `jarvis update`'s restart, and the launchd plist - and because comparing
    // inodes catches spellings a string compare cannot.
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
      console.log(c.dim(`  Dashboard: ${dashboard.label}`));
      console.log(c.dim(`  Logs:      ${logPath}`));
      console.log(c.dim(`  Stop with: jarvis stop`));

      if (!noOpen && dashboard.openUrl) {
        openDashboard(dashboard.openUrl);
      }
    } else {
      console.log(c.red('✗ Failed to start daemon. Check logs:'));
      console.log(c.dim(`  ${logPath}`));
      process.exit(1);
    }
  }
}

// Returns true when the daemon is stopped and its lock cleared; false when a
// daemon still holds the lock (unsignalable, or relaunched by a supervisor).
// Callers decide whether that is fatal — `jarvis restart` must not exit here.
async function cmdStop(args: string[] = [], opts: { verb?: string } = {}): Promise<boolean> {
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
    if (resolution.source === 'invalid-config') {
      // Pid-only rather than "clean up 3142": that port is not ours, and the
      // daemon will not boot from this config either (#550).
      console.log(c.dim(`  ${resolution.problem}`));
      console.log(c.dim('  Stopping by pid only, no port cleanup'));
    } else {
      console.log(c.dim('  Unix-socket mode (daemon.listen) -- pid-only stop, no port cleanup'));
    }
  }

  if (!pid) {
    if (port === null) {
      console.log(c.yellow('JARVIS is not running.'));
      return true;
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
    return true;
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
      if (!isProcessAlive(pid)) { alive = false; break; }
      if (++ticks === 6) console.log(c.dim('  Draining in-flight work...'));
    }

    if (alive) {
      console.log(c.dim('  Drain deadline exceeded, sending SIGKILL...'));
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
      // SIGKILL returns before the kernel finishes the teardown.
      await waitForProcessExit(pid, 2000);
    }

    // releaseLock() unlinks the lockfile whether or not we hold it, so it may
    // only run when nothing holds the flock. Probing the LOCK (rather than the
    // pid we signalled) covers all three ways a daemon can still be there: it
    // ignored/refused our signals (EPERM), or a service manager relaunched it
    // under a new pid (launchd KeepAlive, systemd Restart). Unlinking in either
    // case would let the next `jarvis start` take a fresh inode and run a
    // second daemon against the same data dir.
    // releaseLockIfUnheld() unlinks ONLY when nothing holds the flock, and does
    // it while holding the lock itself — so a supervisor-spawned replacement
    // (launchd KeepAlive, systemd Restart) can neither be mistaken for a dead
    // daemon nor slip in between the check and the unlink.
    if (!releaseLockIfUnheld()) {
      const holder = isLocked();
      const relaunched = holder !== null && holder !== pid;
      console.error(c.red(
        relaunched
          ? `✗ JARVIS daemon (PID ${pid}) stopped, but a new one (PID ${holder}) is already running.`
          : `✗ Could not stop JARVIS daemon (PID ${pid}) — it is still running.`,
      ));
      console.error(c.dim(
        relaunched
          ? '  A service manager restarted it. Remove autostart first: jarvis uninstall (or disable the service).'
          : '  Its lockfile was left in place. Stop it as its owner, or with root.',
      ));
      return false;
    }

    if (port === null) {
      console.log(c.green('✓ JARVIS daemon stopped.'));
      return true;
    }
    const cleanup = await ensurePortReleased(port);
    if (!cleanup.released) {
      console.error(c.red(`✗ JARVIS stopped but port ${port} is still occupied.`));
      return false;
    }

    const details = cleanup.forced.length > 0
      ? ` Force-killed lingering listener(s) on port ${port}: ${cleanup.forced.join(', ')}.`
      : cleanup.terminated.length > 0
        ? ` Cleaned up lingering listener(s) on port ${port}: ${cleanup.terminated.join(', ')}.`
        : '';
    console.log(c.green(`✓ JARVIS daemon stopped.${details}`));
    return true;
  } catch (err) {
    console.error(c.red(`Failed to stop process ${pid}: ${err}`));
    // Same rule as the success path: clear the lock only when nothing holds it
    // (SIGTERM raising ESRCH — a stale lockfile), never while a daemon is live.
    if (!releaseLockIfUnheld()) {
      console.error(c.dim('  A daemon still holds the lock; its lockfile was left in place.'));
      return false;
    }
    return true;
  }
}

/**
 * "Stopped" is ambiguous under systemd: the unit bounds a crash loop
 * (StartLimitBurst, src/cli/autostart.ts), and once that limit is hit systemd
 * leaves the unit failed and never starts it again by itself. Without this, that
 * reads exactly like a daemon the user stopped -- and nothing else would say so.
 * Best effort: costs one `systemctl show` only when a unit is installed.
 */
async function printSystemdFailure(): Promise<void> {
  if (process.platform !== 'linux') return;
  try {
    const { isAutostartInstalled } = await import('../src/cli/autostart.ts');
    if (!isAutostartInstalled()) return;
    const { readUnitFailure } = await import('../src/cli/systemd-unit.ts');
    const failure = readUnitFailure('jarvis.service');
    if (!failure) return;
    console.log(c.yellow(failure.startLimitHit
      ? '  ! systemd stopped restarting jarvis.service: it failed too many times in a row.'
      : `  ! jarvis.service is failed (${failure.result}).`));
    console.log(c.dim('    Why:     journalctl --user -u jarvis.service -n 50'));
    console.log(c.dim('    Recover: systemctl --user reset-failed jarvis.service && systemctl --user start jarvis.service'));
  } catch { /* the status above is what matters */ }
}

async function cmdStatus(): Promise<void> {
  const pid = isLocked();
  if (pid) {
    console.log(`${c.green('●')} JARVIS is ${c.green('running')} (PID ${pid})`);

    // The port the RUNNING daemon recorded when it bound, which is what
    // resolveStopPort reads first, and which also tells it when there is no port
    // to print at all because daemon.listen is a unix socket. It falls back to
    // JARVIS_PORT, then daemon.port, then the default, for the narrow window
    // where a booting daemon holds the lock but has not recorded its port yet.
    // No try/catch: every source it reads swallows its own errors.
    const resolution = resolveStopPort();
    const { label } = describeDashboard({
      url: resolution.port === null ? null : `http://localhost:${resolution.port}`,
      // So a broken daemon.port is not reported as unix-socket mode, which is
      // the other reason there is no URL.
      source: resolution.source,
      problem: resolution.source === 'invalid-config' ? resolution.problem : undefined,
    });
    console.log(c.dim(`  Dashboard: ${label}`));

    console.log(c.dim(`  Stop with: jarvis stop`));
  } else {
    console.log(`${c.red('●')} JARVIS is ${c.red('stopped')}`);
    console.log(c.dim(`  Start with: jarvis start`));
    await printSystemdFailure();
  }

  // Written by an update that ran as a systemd transient, out of sight (#525).
  const { readLastUpdate, describeLastUpdate } = await import('../src/cli/systemd-unit.ts');
  // Only while it still describes this install: a later update by other
  // means (bun update -g, the old path) makes it stale.
  const lastUpdate = readLastUpdate();
  if (lastUpdate && (lastUpdate.to ?? lastUpdate.from) === getVersion()) {
    console.log(c.dim(`  ${describeLastUpdate(lastUpdate)}`));
  }

  // An autostart definition installed before #543/#544 keeps both bugs until
  // autostart is reinstalled, and nothing reinstalls it by itself. Say so here
  // rather than rewriting the file: it may have been edited by hand, and an
  // offer to rewrite belongs to a command that installs autostart, which this
  // CLI does not have. The detector stays quiet unless it is sure.
  // Wrapped: this is an extra on top of the status the user asked for, so a
  // module that fails to load here must not take the whole command down.
  try {
    const { checkInstalledAutostart, describeAutostartProblem } = await import('../src/cli/autostart.ts');
    const drift = checkInstalledAutostart();
    if (drift) {
      console.log(c.yellow(`  ! ${drift.path} still has what this version fixes:`));
      for (const problem of drift.problems) {
        console.log(c.dim(`      ${describeAutostartProblem(problem)}`));
      }
      // A global install has no docs/ on disk, so link it.
      console.log(c.dim('    Fix: https://github.com/vierisid/jarvis/blob/main/docs/SELF_HOSTING.md#refreshing-an-autostart-service'));
    }
  } catch { /* the status above is what matters */ }
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
  // A daemon that is a systemd user unit's main process is restarted by
  // systemd: stopping it from here leaves the unit down, or kills this very
  // command when it runs inside the unit (#525; src/cli/systemd-unit.ts).
  const { routeRestart } = await import('../src/cli/systemd-unit.ts');
  const routed = await routeRestart(args);
  if (routed === 'failed') process.exit(1);
  if (routed === 'done') return;

  // Not a unit's restart: the new daemon starts from this shell's env (#514).
  const warning = modelExecCliWarning('restart', args);
  if (warning) console.warn(c.yellow(warning));

  const pid = isLocked();
  if (pid) {
    if (!await cmdStop()) {
      // Under launchd KeepAlive / systemd Restart the daemon comes straight
      // back under a new pid. That IS the restart the user asked for — report
      // it rather than exiting, and never fall through to cmdStart, which would
      // only fail acquireLock() against the live replacement.
      const holder = isLocked();
      if (holder !== null && holder !== pid) {
        console.log(c.green(`✓ JARVIS restarted by its service manager (PID ${holder}).`));
        return;
      }
      process.exit(1);
    }
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
    const n = parseInt(args[nIdx + 1]!, 10);
    if (!isNaN(n) && n > 0) lines = n;
  }

  console.log(c.dim(`Log file: ${logPath}\n`));

  if (follow) {
    // tail -f equivalent
    // -F, not -f: the daemon's file sink caps the log by rewriting it through
    // a temp file + rename, so the inode changes and a plain `tail -f` would
    // keep following a deleted inode and go silent. -F follows by NAME.
    //
    // The cost of that, and it is visible: on every compaction GNU tail says
    // "has been replaced; following new file" and reprints the ENTIRE new
    // file, so a follower sees ~1 MiB of already-seen lines about every
    // 256 KiB of new output at the default cap. Inherent to capping one file
    // in place - rotation and truncate-in-place restart a tailer too - and
    // documented in README.md / docs/SELF_HOSTING.md rather than worked
    // around, because every workaround costs more than the noise does.
    const tailProc = Bun.spawn(['tail', '-F', '-n', String(lines), logPath], {
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

// Takes the URL, not a port: the caller resolves it once (resolveDashboardTarget)
// and has already decided there is one to open at all (#544).
function openDashboard(url: string): void {
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

// A daemon started from the assistant's shell (run_command) comes up without
// the workflow key that shell was stripped of (#514). Which commands warn, and
// why only those, is modelExecCliWarning's; `restart` warns from cmdRestart,
// once it knows systemd is not the one restarting (#525), and `update` from
// update.ts.
if (command !== 'restart') {
  const warning = modelExecCliWarning(command, commandArgs);
  if (warning) console.warn(c.yellow(warning));
}

switch (command) {
  case 'start':
    await cmdStart(commandArgs);
    break;
  case 'stop':
    if (!await cmdStop(commandArgs)) process.exit(1);
    break;
  case 'drain':
    // Same signal as stop (SIGTERM -> bounded graceful drain); clearer label.
    if (!await cmdStop(commandArgs, { verb: 'Draining' })) process.exit(1);
    break;
  case 'restart':
    await cmdRestart(commandArgs);
    break;
  case 'status':
    await cmdStatus();
    break;
  case 'logs':
  case 'log':
    cmdLogs(commandArgs);
    break;
  case 'update':
  case 'upgrade':
    await cmdUpdate();
    break;
  case 'onboard': {
    console.log(c.yellow('The CLI onboarding wizard has been retired.'));
    console.log(c.dim('  First-time setup now happens in the dashboard:'));
    console.log(c.dim('    1. Run: jarvis start'));
    const described = describeDashboard(resolveDashboardTarget());
    // On the reason, not on openUrl being null: a config the daemon refuses
    // also has no URL, and pointing that user at a proxy is a dead end (#550).
    console.log(c.dim(described.reason === 'url'
      ? `    2. Open: ${described.openUrl}`
      : described.reason === 'invalid-config'
        ? `    2. Fix your config first: ${described.problem}`
        : '    2. Reach the unix socket in daemon.listen through your proxy'));
    console.log(c.dim('  The dashboard guides you through LLM, voice, and profile setup.'));
    break;
  }
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

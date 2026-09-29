/**
 * Autostart Setup for J.A.R.V.I.S.
 *
 * Installs/uninstalls keepalive daemon autostart:
 * - Linux: systemd user service
 * - macOS: launchd user agent
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { c, printOk, printErr, printWarn } from './helpers.ts';
import { getLogDir } from '../daemon/pid.ts';
import { MODEL_EXEC_ENV_KEY_FLAG, MODEL_EXEC_MARKER_ENV } from '../util/model-exec-marker.ts';

function canSpawnBinary(binary: string): boolean {
  try {
    return Boolean(Bun.which(binary));
  } catch {
    return false;
  }
}

function spawnDetachedShell(command: string, requiredBinaries: string[]): boolean {
  if (!requiredBinaries.every(canSpawnBinary)) {
    return false;
  }

  try {
    const child = spawn('bash', ['-lc', command], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
    });
    if (child.pid == null) {
      return false;
    }
    child.once('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function getBunPath(): string {
  try {
    return Bun.which('bun') ?? 'bun';
  } catch {
    return 'bun';
  }
}

function getJarvisPath(): string {
  // When installed globally, import.meta.dir points to the package
  return join(import.meta.dir, '../../bin/jarvis.ts');
}

export type SpawnResultLike = {
  exitCode: number;
  stdout?: Uint8Array | ArrayBuffer | null;
  stderr?: Uint8Array | ArrayBuffer | null;
};

export type SpawnSyncFn = (cmd: string[], opts?: { stdout?: 'ignore'; stderr?: 'ignore' }) => SpawnResultLike;

const defaultSpawnSync: SpawnSyncFn = (cmd, opts) => Bun.spawnSync(cmd, opts as never) as unknown as SpawnResultLike;

export type SystemdProbeResult = { supported: boolean; reason?: string };

function firstNonEmpty(...outputs: (Uint8Array | ArrayBuffer | null | undefined)[]): string {
  for (const o of outputs) {
    const text = decodeLaunchctlOutput(o).trim();
    if (text) return text.split('\n')[0]!.slice(0, 200);
  }
  return '';
}

export function probeSystemdUserService(spawnSync: SpawnSyncFn = defaultSpawnSync): SystemdProbeResult {
  try {
    const version = spawnSync(['systemctl', '--user', '--version']);
    if (version.exitCode !== 0) {
      return { supported: false, reason: firstNonEmpty(version.stderr, version.stdout) || 'systemctl --user not available' };
    }

    const state = spawnSync(['systemctl', '--user', 'is-system-running']);
    // "running" exits 0, degraded/offline can still manage units and usually exits non-zero.
    // We only need the user manager to be reachable, not fully healthy.
    if (state.exitCode === 0) return { supported: true };

    const env = spawnSync(['systemctl', '--user', 'show-environment']);
    if (env.exitCode === 0) return { supported: true };

    return {
      supported: false,
      reason: firstNonEmpty(env.stderr, env.stdout, state.stderr, state.stdout) || 'user systemd manager unreachable',
    };
  } catch (err) {
    return { supported: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

export function canUseSystemdUserService(spawnSync: SpawnSyncFn = defaultSpawnSync): boolean {
  return probeSystemdUserService(spawnSync).supported;
}

// ── systemd (Linux) ──────────────────────────────────────────────────

const SYSTEMD_DIR = join(homedir(), '.config', 'systemd', 'user');
const SYSTEMD_UNIT_NAME = 'jarvis.service';
const SYSTEMD_SERVICE = join(SYSTEMD_DIR, SYSTEMD_UNIT_NAME);

/**
 * The #514 markers (util/model-exec-marker.ts) must never reach the service: a
 * `systemctl --user import-environment` run from the assistant's shell would
 * otherwise mark the manager, and every later start of the unit with it.
 * UnsetEnvironment= needs systemd 235 (2017). An older systemd logs an unknown
 * key and ignores the line, so the unit still loads everywhere. A unit
 * installed before this line existed gets it only when autostart is
 * reinstalled.
 */
const SYSTEMD_UNSET_MODEL_EXEC = `UnsetEnvironment=${MODEL_EXEC_MARKER_ENV} ${MODEL_EXEC_ENV_KEY_FLAG}`;

export function generateSystemdUnit(): string {
  const bunPath = getBunPath();
  const jarvisPath = getJarvisPath();

  return `[Unit]
Description=J.A.R.V.I.S. Daemon
After=network.target
# A daemon that cannot boot must not be restarted forever: five starts inside
# two minutes and systemd gives up and leaves the unit failed. At RestartSec=5
# that caps a crash loop at about 20 seconds. systemd's own default (5 starts
# in 10s) can never be reached at that interval, so this has to be explicit.
# These two keys belong in [Unit]; systemd ignores StartLimitIntervalSec in
# [Service] (and needs systemd 229+ for the name at all).
# Recover a rate-limited unit with: systemctl --user reset-failed jarvis.service
StartLimitIntervalSec=120
StartLimitBurst=5

[Service]
Type=simple
# --no-open, because the service starts at login, after a crash and after an
# update: without it every start tries to open a browser -- a failed attempt on
# a headless box, a tab popping up on a desktop (#544).
ExecStart=${bunPath} ${jarvisPath} start --foreground --no-open
# on-failure, not always: \`jarvis stop\` and \`jarvis drain\` SIGTERM the daemon
# directly rather than going through systemctl, and that drain ends in a clean
# exit. Under Restart=always systemd would bring JARVIS back RestartSec after
# the CLI reported it stopped. A crash exits non-zero (#543), so on-failure
# covers the case this exists for.
Restart=on-failure
RestartSec=5
Environment=HOME=${homedir()}
${SYSTEMD_UNSET_MODEL_EXEC}
${systemdJarvisHomeLine()}
[Install]
WantedBy=default.target
`;
}

/**
 * Propagate JARVIS_HOME into the systemd unit when the installing shell has one
 * set.
 *
 * Without this the service runs against ~/.jarvis while the CLI that installed
 * it (and `jarvis logs`, and the restart in `jarvis update`) resolves
 * $JARVIS_HOME — so the daemon locks and logs under one root while every tool
 * looks under another. Emits nothing when the var is unset, which keeps the
 * default single-root install byte-identical.
 *
 * The assignment is quoted and escaped: systemd splits an unquoted
 * `Environment=` on whitespace, reads `%` as a specifier introducer, and treats
 * `\` and `"` as escape/terminator INSIDE the quotes. Any of them in the data
 * root would truncate or mangle the value — landing the daemon on a different
 * root than the CLI, the exact split this prevents. Backslash first, so the
 * escapes added afterwards aren't doubled.
 */
function systemdJarvisHomeLine(): string {
  const home = process.env.JARVIS_HOME;
  if (!home) return '';
  const escaped = home
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/%/g, '%%');
  return `Environment="JARVIS_HOME=${escaped}"\n`;
}

/** Escape a value for interpolation into plist text content. */
function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function installSystemd(): Promise<boolean> {
  try {
    if (!existsSync(SYSTEMD_DIR)) {
      mkdirSync(SYSTEMD_DIR, { recursive: true });
    }

    writeFileSync(SYSTEMD_SERVICE, generateSystemdUnit(), 'utf-8');

    // Reload systemd and enable
    const reload = Bun.spawnSync(['systemctl', '--user', 'daemon-reload']);
    if (reload.exitCode !== 0) {
      printErr('Failed to reload systemd. You may need to run: systemctl --user daemon-reload');
      return false;
    }

    const enable = Bun.spawnSync(['systemctl', '--user', 'enable', 'jarvis.service']);
    if (enable.exitCode !== 0) {
      printErr('Failed to enable service. You may need to run: systemctl --user enable jarvis.service');
      return false;
    }

    // Enable lingering so the service runs even when not logged in
    const lingering = Bun.spawnSync(['loginctl', 'enable-linger', process.env.USER ?? '']);
    const lingers = lingering.exitCode === 0;
    if (!lingers) {
      printWarn('Could not enable lingering. The service will stop when you log out.');
    }

    printOk(`Installed systemd service: ${SYSTEMD_SERVICE}`);
    // Said precisely, because Restart=on-failure is the whole point of #543: a
    // clean `jarvis stop` is NOT undone, and "on boot" is true only with linger.
    printOk(lingers
      ? 'It starts JARVIS at boot and restarts it after a crash; a clean stop is left alone.'
      : 'It starts JARVIS at login and restarts it after a crash; a clean stop is left alone.');
    return true;
  } catch (err) {
    printErr(`Failed to install systemd service: ${err}`);
    return false;
  }
}

async function startSystemdService(): Promise<boolean> {
  try {
    // No reset-failed here, unlike scheduleSystemdRestart: this start is
    // blocking and reports its own failure, including "Start request repeated
    // too quickly", so it cannot leave the user thinking JARVIS came up. Adding
    // one would also add an unsanitized spawn (src/spawn-env-guard.test.ts) to a
    // path that runs right after the unit was written and enabled.
    const start = Bun.spawnSync(['systemctl', '--user', 'start', 'jarvis.service']);
    if (start.exitCode !== 0) {
      printErr('Failed to start systemd service. You may need to run: systemctl --user start jarvis.service');
      return false;
    }

    printOk('JARVIS keepalive service is running.');
    return true;
  } catch (err) {
    printErr(`Failed to start systemd service: ${err}`);
    return false;
  }
}

export function scheduleSystemdRestart(spawnSync: SpawnSyncFn = defaultSpawnSync): boolean {
  try {
    // The unit's StartLimitBurst counts EVERY start in the window, not only the
    // ones Restart= triggers: enough restarts or updates in two minutes and
    // systemd refuses the next start. Clear the counter first, or --no-block
    // reports success below while JARVIS stays down. A no-op (exit 0) on a unit
    // that is running normally, so the result is deliberately ignored.
    spawnSync(['systemctl', '--user', 'reset-failed', 'jarvis.service']);
    // --no-block returns immediately; systemd queues the restart through its own
    // lifecycle, so the calling HTTP handler can return before the unit cycles.
    const res = spawnSync(['systemctl', '--user', '--no-block', 'restart', 'jarvis.service']);
    return res.exitCode === 0;
  } catch {
    return false;
  }
}

async function uninstallSystemd(): Promise<boolean> {
  try {
    Bun.spawnSync(['systemctl', '--user', 'stop', 'jarvis.service']);
    Bun.spawnSync(['systemctl', '--user', 'disable', 'jarvis.service']);

    const had = existsSync(SYSTEMD_SERVICE);
    if (had) {
      unlinkSync(SYSTEMD_SERVICE);
    }

    Bun.spawnSync(['systemctl', '--user', 'daemon-reload']);
    // `jarvis autostart --uninstall` runs this even with no file on disk, since
    // the unit can still be enabled and running then. Say which one happened.
    printOk(had
      ? 'Uninstalled systemd service.'
      : `Stopped and disabled ${SYSTEMD_UNIT_NAME}; there was no unit file to remove.`);
    return true;
  } catch (err) {
    printErr(`Failed to uninstall systemd service: ${err}`);
    return false;
  }
}

function isSystemdInstalled(): boolean {
  return existsSync(SYSTEMD_SERVICE);
}

// ── Is the INSTALLED definition still the one we would write? ────────
//
// A unit or plist is only rewritten when autostart is reinstalled, so an
// install made before #543/#544 keeps opening a browser on every start and
// keeps restarting a daemon that cannot boot, every RestartSec, forever -- the
// second one matters MORE now that a crash exits non-zero. Nothing in the
// product reinstalls it, so the most it can honestly do is say so.

/** A consequence of the installed definition, named by what the user sees. */
export type AutostartProblem = 'opens-a-browser' | 'unbounded-restarts' | 'relaunches-after-a-clean-stop';

export interface AutostartDrift {
  /** The file the problems were read from. */
  path: string;
  problems: AutostartProblem[];
}

/**
 * One `KEY=value` from a unit file, with its section.
 *
 * Tolerant on purpose, because a false report here nags forever: leading
 * whitespace (systemd allows indentation), CRLF, comments, and a `\` line
 * continuation, which a regex over single lines would read as a truncated
 * value.
 */
function parseUnitDirectives(text: string): { section: string; key: string; value: string }[] {
  const out: { section: string; key: string; value: string }[] = [];
  let section = '';
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    if (line.startsWith('[')) {
      section = line.replace(/^\[|\].*$/g, '');
      continue;
    }
    while (line.endsWith('\\') && i + 1 < lines.length) {
      line = `${line.slice(0, -1).trim()} ${lines[++i]!.trim()}`;
    }
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    out.push({ section, key: line.slice(0, eq).trim(), value: line.slice(eq + 1).trim() });
  }
  return out;
}

/**
 * A systemd time span in seconds, for the values this needs to compare. Bare
 * numbers are seconds; `s`/`sec`/`min`/`ms` cover what a hand-edited RestartSec
 * realistically says. Anything else is null, i.e. "do not guess".
 */
function timeSpanSeconds(value: string | undefined): number | null {
  if (value === undefined) return null;
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|seconds?|m|min|mins|minutes?)?$/.exec(value.trim());
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isFinite(n)) return null;
  switch (match[2]) {
    case 'ms': return n / 1000;
    case 'm': case 'min': case 'mins': case 'minute': case 'minutes': return n * 60;
    default: return n;
  }
}

/** systemd's argv splitting, enough of it: quotes off, exec prefixes off. */
function execTokens(value: string): string[] {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((token, index) => (index === 0 ? token.replace(/^[-@:!+]+/, '') : token))
    .map((token) => token.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1'));
}

/**
 * What the installed systemd unit still gets wrong, or null when there is
 * nothing to report.
 *
 * Null (not an empty list) when nothing is installed, when the file cannot be
 * read, and when this unit's own drop-in directory exists: docs/SELF_HOSTING.md
 * tells people to `systemctl --user edit jarvis.service`, and a drop-in can set
 * ExecStart or Restart without the main file showing it. Reporting on the main
 * file alone would nag someone who has already fixed it.
 *
 * That guard covers `<unit>.d/` beside the unit, which is where `systemctl edit`
 * writes. systemd also reads top-level `service.d/` and the same paths under
 * /etc and /run; an override placed there is still reported. Conservative in the
 * other direction is not an option here -- something has to be read.
 */
export function checkInstalledSystemdUnit(unitPath = SYSTEMD_SERVICE): AutostartDrift | null {
  let text: string;
  try {
    if (!existsSync(unitPath)) return null;
    // A drop-in that actually overrides something. An empty `<unit>.d/`, left by
    // a `systemctl edit` somebody aborted, would otherwise silence this forever.
    if (existsSync(`${unitPath}.d`) && readdirSync(`${unitPath}.d`).some((f) => f.endsWith('.conf'))) return null;
    text = readFileSync(unitPath, 'utf-8');
  } catch {
    return null;
  }

  const directives = parseUnitDirectives(text);
  const service = directives.filter((d) => d.section === 'Service');
  const problems: AutostartProblem[] = [];

  // The last non-empty ExecStart, which is the command systemd would run in
  // every unit that loads: more than one is only legal for Type=oneshot, and
  // otherwise only after an empty assignment has reset the list.
  const execStart = service.filter((d) => d.key === 'ExecStart' && d.value !== '').at(-1);
  const argv = execStart ? execTokens(execStart.value) : [];
  // Only a unit shaped like the ones this file writes is judged at all. Somebody
  // else's jarvis.service -- a wrapper script, a `docker run`, a shell -c that
  // passes --no-open itself -- would otherwise be nagged about on every `jarvis
  // status` forever, with no way to silence it. Every unit this repo has ever
  // generated runs `... jarvis.ts start --foreground`.
  if (!argv.includes('start')) return null;

  if (!argv.includes('--no-open')) {
    problems.push('opens-a-browser');
  }

  // Unbounded only when systemd's OWN default limit cannot bite either: at the
  // default 5 starts per 10s, a unit that waits RestartSec >= 2s between tries
  // never reaches it, so an explicit limit is the only thing that ends a loop.
  // Anyone who set one of the two keys that bound a loop is left alone
  // (StartLimitAction is not one of them: it says what to do AT the limit).
  //
  // RestartSec is read as a time span, so a hand-written `5s` or `2min` counts
  // like the bare `5` the generator writes. A value this cannot read at all
  // stays SILENT rather than guessing.
  const restart = service.filter((d) => d.key === 'Restart').at(-1)?.value;
  const restartSec = timeSpanSeconds(service.filter((d) => d.key === 'RestartSec').at(-1)?.value);
  const hasLimit = directives.some((d) =>
    d.key === 'StartLimitBurst' || d.key === 'StartLimitIntervalSec' || d.key === 'StartLimitInterval');
  if (restart && restart !== 'no' && !hasLimit && restartSec !== null && restartSec * 5 >= 10) {
    problems.push('unbounded-restarts');
  }

  return problems.length > 0 ? { path: unitPath, problems } : null;
}

/** One line each, in the order they bite. */
export function describeAutostartProblem(problem: AutostartProblem): string {
  switch (problem) {
    case 'opens-a-browser':
      return 'it opens a browser on every start, including every restart after a crash';
    case 'unbounded-restarts':
      return 'a daemon that cannot boot is restarted forever, with no start limit';
    case 'relaunches-after-a-clean-stop':
      return 'a `jarvis stop` is undone moments later: it relaunches the daemon after a clean exit too';
  }
}

// ── launchd (macOS) ──────────────────────────────────────────────────

const LAUNCHD_DIR = join(homedir(), 'Library', 'LaunchAgents');
const LAUNCHD_LABEL = 'ai.jarvis.daemon';
const LAUNCHD_PLIST = join(LAUNCHD_DIR, `${LAUNCHD_LABEL}.plist`);

export function generateLaunchdPlist(): string {
  const bunPath = getBunPath();
  const jarvisPath = getJarvisPath();
  // getLogDir() so the plist's StandardOutPath matches where the daemon itself
  // resolves its log file (both honor JARVIS_HOME) — and the plist exports the
  // var below, so the launched daemon agrees with this path.
  //
  // launchd opens these two paths and hands the daemon the descriptors as fds
  // 1/2. If daemon.log_file_path names the same file, the daemon detects that
  // by inode (src/daemon/index.ts) and skips its in-process sink: the sink caps
  // by renaming a fresh file over the path, which would leave launchd's
  // descriptors appending to an unlinked inode that grows without bound.
  const logDir = getLogDir();
  // --no-open for the same reason as the systemd unit (#544): the agent starts
  // at login and is relaunched after a crash, and every one of those would
  // otherwise pop a browser tab.
  //
  // `KeepAlive` is a DICT with `SuccessfulExit=false` -- the launchd equivalent
  // of the unit's Restart=on-failure (#549). A bare `<true/>` relaunches after
  // ANY exit, so the clean drain a `jarvis stop` triggers was undone under a new
  // pid while the CLI printed success. (Not "ten seconds later", despite the
  // issue text: ThrottleInterval only bounds how often a job that just started
  // may respawn, so a daemon that had been up a while came back at once.)
  // `jarvis stop` signals the daemon's pid and never goes through launchctl, so
  // launchd cannot tell a requested stop from a crash by itself; the exit status
  // is all it has, and the daemon's is 0 on a drain and 3/4 on a crash (#543).
  //
  // SuccessfulExit alone. `Crashed=true` could be ORed in -- a KeepAlive dict
  // keeps the job alive while ANY of its conditions is met, and exit 0 satisfies
  // neither -- but it would only restate what the man page already says about
  // the inverse condition, and it cannot be verified from here. `Crashed=false`
  // is the one that must never appear: it reads as "relaunch when it did NOT
  // crash", which is the clean-exit relaunch all over again.
  //
  // Two things the systemd half of #543 still does that this cannot:
  //   - launchd throttles respawns to ~10s but has no StartLimitBurst and never
  //     gives up, so the crash-loop BOUND is Linux-only. A daemon that dies on
  //     boot is relaunched every ~10s for as long as the Mac is up.
  //   - a death by signal never "exited with status 0", so launchd's inverse
  //     condition should relaunch it: a real kill, and also the SIGKILL `jarvis
  //     stop` escalates to when the drain overruns its deadline. Reading the man
  //     page, not measured -- src/cli/daemon-control.launchd.test.ts proves the
  //     exit-status halves on the macOS runner and this one is left open, which
  //     is also why src/cli/uninstall.ts still removes autostart BEFORE it stops
  //     the daemon: that order is right either way.

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(bunPath)}</string>
    <string>${xmlEscape(jarvisPath)}</string>
    <string>start</string>
    <string>--foreground</string>
    <string>--no-open</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logDir)}/jarvis.log</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logDir)}/jarvis-error.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${xmlEscape(homedir())}</string>
${process.env.JARVIS_HOME ? `    <key>JARVIS_HOME</key>\n    <string>${xmlEscape(process.env.JARVIS_HOME)}</string>\n` : ''}    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:${xmlEscape(join(homedir(), '.bun', 'bin'))}</string>
    <key>${MODEL_EXEC_MARKER_ENV}</key>
    <string></string>
    <key>${MODEL_EXEC_ENV_KEY_FLAG}</key>
    <string></string>
  </dict>
</dict>
</plist>
`;
}

async function installLaunchd(): Promise<boolean> {
  try {
    if (!existsSync(LAUNCHD_DIR)) {
      mkdirSync(LAUNCHD_DIR, { recursive: true });
    }

    // Ensure log directory exists
    const logDir = getLogDir();
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }

    writeFileSync(LAUNCHD_PLIST, generateLaunchdPlist(), 'utf-8');

    printOk(`Installed launchd plist: ${LAUNCHD_PLIST}`);
    // KeepAlive is {SuccessfulExit: false} since #549, so this is exactly what
    // it does: a crash comes back, a clean `jarvis stop` does not.
    printOk('It starts JARVIS at login and outlives the terminal; a crash is relaunched, a clean stop is not.');
    return true;
  } catch (err) {
    printErr(`Failed to install launchd plist: ${err}`);
    return false;
  }
}

const utf8Decoder = new TextDecoder('utf-8');

export function decodeLaunchctlOutput(output: Uint8Array | ArrayBuffer | null | undefined): string {
  if (!output) {
    return '';
  }

  try {
    return utf8Decoder.decode(output);
  } catch {
    return '';
  }
}

export function isLaunchdAlreadyLoaded(result: SpawnResultLike): boolean {
  if (result.exitCode === 0) {
    return false;
  }

  const combinedOutput = `${decodeLaunchctlOutput(result.stdout)}\n${decodeLaunchctlOutput(result.stderr)}`.toLowerCase();
  return (
    combinedOutput.includes('already loaded') ||
    combinedOutput.includes('service already loaded') ||
    combinedOutput.includes('already bootstrapped') ||
    combinedOutput.includes('service already exists')
  );
}

/**
 * launchctl's way of saying the job was not loaded in the first place, which is
 * the outcome a removal wanted. `bootout` exits non-zero for it, so without this
 * an already-clean machine would look like a failure.
 */
export function isLaunchdNotLoaded(result: SpawnResultLike): boolean {
  const combined = `${decodeLaunchctlOutput(result.stdout)}\n${decodeLaunchctlOutput(result.stderr)}`.toLowerCase();
  return (
    combined.includes('not loaded') ||
    combined.includes('no such process') ||
    combined.includes('no such file or directory') ||
    combined.includes('could not find specified service') ||
    combined.includes('service not found')
  );
}

function launchctlReason(result: SpawnResultLike): string {
  const combined = `${decodeLaunchctlOutput(result.stderr)}\n${decodeLaunchctlOutput(result.stdout)}`.trim();
  const first = combined.split('\n').find((line) => line.trim().length > 0);
  return (first ?? `exit ${result.exitCode}`).slice(0, 200);
}

async function startLaunchdService(options: { replaceLoaded?: boolean } = {}): Promise<boolean> {
  try {
    const getuid = process.getuid;
    const uid = typeof getuid === 'function' ? getuid.call(process) : undefined;

    // A rewritten plist only becomes live after the agent is booted out and
    // bootstrapped again; bootstrap alone reports "already loaded" and keeps the
    // definition launchd read last. The caller only asks for this when nothing
    // holds the lock, so booting the agent out stops nothing that is in use.
    if (options.replaceLoaded && typeof uid === 'number') {
      Bun.spawnSync(['launchctl', 'bootout', `gui/${uid}/${LAUNCHD_LABEL}`]);
    }

    let bootstrapReason: string | null = null;
    if (typeof uid === 'number') {
      const bootstrap = Bun.spawnSync(['launchctl', 'bootstrap', `gui/${uid}`, LAUNCHD_PLIST]);
      // Two different outcomes, and only the first one started anything:
      // bootstrap on an ALREADY loaded agent does not re-run RunAtLoad, so it
      // leaves whatever definition launchd loaded before in place. Saying "is
      // running" for both is how a refresh would report success while the daemon
      // still ran the old plist.
      if (bootstrap.exitCode === 0) {
        printOk('Loaded the launch agent; RunAtLoad starts JARVIS now.');
        return true;
      }
      if (isLaunchdAlreadyLoaded(bootstrap)) {
        // After a bootout we asked for, "already loaded" means the teardown did
        // not take (it can answer "Operation now in progress"), so the plist we
        // just wrote is NOT live. Reporting success here is how `--force` would
        // exit 0 with the old definition running -- the very thing replaceLoaded
        // exists to prevent.
        if (options.replaceLoaded) {
          printErr('The launch agent is still loaded with its previous definition; the new plist is not live.');
          printWarn(`Retry with: launchctl bootout gui/${uid}/${LAUNCHD_LABEL} && launchctl bootstrap gui/${uid} ${LAUNCHD_PLIST}`);
          return false;
        }
        printOk('The launch agent was already loaded; launchd keeps the definition it loaded.');
        printWarn(`Apply this plist now with: launchctl bootout gui/${uid}/${LAUNCHD_LABEL} && launchctl bootstrap gui/${uid} ${LAUNCHD_PLIST}`);
        return true;
      }
      bootstrapReason = launchctlReason(bootstrap);
    } else {
      bootstrapReason = 'could not determine current user UID';
      printWarn('Skipping launchctl bootstrap — no UID; falling back to launchctl load.');
    }

    const load = Bun.spawnSync(['launchctl', 'load', LAUNCHD_PLIST]);
    if (load.exitCode !== 0 && !isLaunchdAlreadyLoaded(load)) {
      const loadReason = launchctlReason(load);
      printWarn(
        `Installed launchd plist, but could not start it immediately. It should start on next login. ` +
          `(bootstrap: ${bootstrapReason}; load: ${loadReason})`,
      );
      return false;
    }

    printOk('Loaded the launch agent.');
    return true;
  } catch (err) {
    printWarn(`Installed launchd plist, but could not start it immediately: ${err}`);
    return false;
  }
}

function scheduleLaunchdRestart(): boolean {
  const uid = process.getuid?.();
  const command = uid != null
    ? `sleep 1; launchctl kickstart -k gui/${uid}/${LAUNCHD_LABEL} >/dev/null 2>&1`
    : `sleep 1; launchctl kickstart -k gui/$(id -u)/${LAUNCHD_LABEL} >/dev/null 2>&1`;
  return spawnDetachedShell(command, ['bash', 'launchctl']);
}

async function uninstallLaunchd(): Promise<boolean> {
  try {
    const had = existsSync(LAUNCHD_PLIST);
    const getuid = process.getuid;
    const uid = typeof getuid === 'function' ? getuid.call(process) : undefined;

    // Unloading is the step that matters, and it runs whether or not the file is
    // there: launchd keeps the job loaded from whatever it read at login, so a
    // plist somebody deleted by hand leaves an agent that is still relaunching
    // the daemon. `jarvis uninstall` depends on this to avoid the loop where the
    // stop it does next is undone before it can finish (src/cli/uninstall.ts).
    //
    // `bootout` by LABEL, like the install's `bootstrap`, with the legacy
    // `unload` (which needs the path) as the fallback -- and the result is
    // CHECKED. Deleting the file after a failed unload is how an uninstall
    // reports success while the agent stays loaded, with the plist that would
    // have let the user retry now gone.
    let reason = '';
    let unloaded = false;
    if (typeof uid === 'number') {
      const bootout = Bun.spawnSync(['launchctl', 'bootout', `gui/${uid}/${LAUNCHD_LABEL}`]);
      unloaded = bootout.exitCode === 0 || isLaunchdNotLoaded(bootout);
      if (!unloaded) reason = `bootout: ${launchctlReason(bootout)}`;
    } else {
      reason = 'could not determine current user UID';
    }
    if (!unloaded && had) {
      const unload = Bun.spawnSync(['launchctl', 'unload', LAUNCHD_PLIST]);
      unloaded = unload.exitCode === 0 || isLaunchdNotLoaded(unload);
      if (!unloaded) reason = `${reason}; unload: ${launchctlReason(unload)}`;
    }
    if (!unloaded) {
      printErr(`Could not unload the launch agent (${reason}).`);
      printWarn(`Leaving ${LAUNCHD_PLIST} in place, so it can be retried: launchctl bootout gui/$(id -u)/${LAUNCHD_LABEL}`);
      return false;
    }

    if (had) unlinkSync(LAUNCHD_PLIST);
    printOk(had
      ? 'Uninstalled launchd plist.'
      : 'Unloaded the launch agent; there was no plist to remove.');
    return true;
  } catch (err) {
    printErr(`Failed to uninstall launchd plist: ${err}`);
    return false;
  }
}

function isLaunchdInstalled(): boolean {
  return existsSync(LAUNCHD_PLIST);
}

/** What the installed plist's `KeepAlive` amounts to, as far as this can tell. */
export type PlistKeepAlive = 'absent' | 'always' | 'never' | 'on-failure' | 'unknown';

/**
 * The `KeepAlive` value of a plist, read from its text.
 *
 * Tolerant in the same direction as parseUnitDirectives: `unknown` for anything
 * it cannot read with certainty, so the caller stays quiet rather than nagging
 * about a plist somebody built themselves. Only three answers are definite:
 * `<true/>` (relaunch after ANY exit, #549), `<false/>`/absent (no relaunch at
 * all) and a dict whose only condition is `SuccessfulExit=false`, which is what
 * generateLaunchdPlist writes. A dict with any other condition in it -- launchd
 * ORs them, and PathState/OtherJobEnabled/Crashed all change the answer -- reads
 * as `unknown`.
 */
export function readPlistKeepAlive(text: string): PlistKeepAlive {
  // Comments first: a commented-out <true/> must not be read as the value.
  const clean = text.replace(/<!--[\s\S]*?-->/g, '');
  // A plist parser takes the LAST of a duplicated key, so reading the first
  // would get both directions wrong: somebody who appended a corrected block
  // would be nagged although they had fixed it, and somebody who appended
  // `<true/>` after the dict would not be told. There is no reason to guess
  // which one CFPropertyList picks -- more than one is `unknown`, i.e. quiet.
  if (clean.split('<key>KeepAlive</key>').length > 2) return 'unknown';
  const at = clean.indexOf('<key>KeepAlive</key>');
  if (at === -1) return 'absent';
  const rest = clean.slice(at + '<key>KeepAlive</key>'.length).trimStart();
  if (/^<true\s*\/>|^<true\s*>\s*<\/true\s*>/.test(rest)) return 'always';
  if (/^<false\s*\/>|^<false\s*>\s*<\/false\s*>/.test(rest)) return 'never';
  if (!/^<dict\s*>/.test(rest)) return 'unknown';

  // The dict's own extent, counting nested <dict> (PathState and friends are
  // dicts). Defensive rather than load-bearing: the key scan below counts keys
  // at any depth, so a nested dict already forces `unknown` through its own key.
  // What this does decide is the unterminated case (end === -1).
  let depth = 0;
  let end = -1;
  const tag = /<(\/?)dict\s*>/g;
  let m: RegExpExecArray | null;
  while ((m = tag.exec(rest)) !== null) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) { end = m.index; break; }
  }
  if (end === -1) return 'unknown';
  const body = rest.slice(rest.indexOf('>') + 1, end);

  // Exactly one condition, and it is SuccessfulExit=false. Any extra key means
  // launchd is ORing in something this cannot reason about.
  const keys = [...body.matchAll(/<key>([^<]*)<\/key>/g)].map((k) => k[1]!.trim());
  if (keys.length !== 1 || keys[0] !== 'SuccessfulExit') return 'unknown';
  const value = body.slice(body.indexOf('</key>') + '</key>'.length).trim();
  if (/^<false\s*\/>|^<false\s*>\s*<\/false\s*>/.test(value)) return 'on-failure';
  if (/^<true\s*\/>|^<true\s*>\s*<\/true\s*>/.test(value)) return 'unknown';
  return 'unknown';
}

/**
 * The stale-install question (see checkInstalledSystemdUnit) for the launchd
 * plist: an older one opens a browser on every relaunch (#544) and relaunches
 * the daemon after a clean `jarvis stop` (#549).
 */
export function checkInstalledLaunchdPlist(plistPath = LAUNCHD_PLIST): AutostartDrift | null {
  let text: string;
  try {
    if (!existsSync(plistPath)) return null;
    text = readFileSync(plistPath, 'utf-8');
  } catch {
    return null;
  }
  // Sliced to ProgramArguments, so a `--no-open` under some other key cannot
  // pass for an argument the daemon is actually started with.
  const at = text.indexOf('<key>ProgramArguments</key>');
  if (at === -1) return null;
  const end = text.indexOf('</array>', at);
  const argv = text.slice(at, end === -1 ? undefined : end);
  // Only a plist shaped like the ones this file writes is judged at all, the
  // same approximation checkInstalledSystemdUnit makes: an agent that runs
  // something else entirely is left alone. It is an approximation -- a wrapper
  // invoked as `wrap.sh start` passes it -- and, when the `</array>` is missing
  // (so `argv` runs to the end of the file), it reads strings outside the array.
  // Such a plist is not valid XML and launchd would not load it either.
  if (!argv.includes('<string>start</string>')) return null;

  const problems: AutostartProblem[] = [];
  if (!argv.includes('<string>--no-open</string>')) problems.push('opens-a-browser');
  if (readPlistKeepAlive(text) === 'always') problems.push('relaunches-after-a-clean-stop');
  return problems.length > 0 ? { path: plistPath, problems } : null;
}

/**
 * Drift in the autostart definition installed on THIS platform, or null when
 * there is nothing to report. Read-only: rewriting the file from here would
 * clobber hand edits, and only a reinstall may touch it.
 */
export function checkInstalledAutostart(): AutostartDrift | null {
  if (process.platform === 'darwin') return checkInstalledLaunchdPlist();
  if (process.platform !== 'linux') return null;
  return checkInstalledSystemdUnit();
}

// ── Public API ───────────────────────────────────────────────────────

/** Which service manager this platform's autostart definition is written for. */
export type AutostartKind = 'systemd' | 'launchd';

/** systemd's unit name, or launchd's label: what `systemctl`/`launchctl` take. */
export function getAutostartUnitName(): string {
  return process.platform === 'darwin' ? LAUNCHD_LABEL : SYSTEMD_UNIT_NAME;
}

/**
 * Where this platform's autostart definition lives, or null where there is no
 * autostart at all (any platform other than Linux and macOS).
 */
export function getAutostartPath(): string | null {
  if (process.platform === 'darwin') return LAUNCHD_PLIST;
  if (process.platform === 'linux') return SYSTEMD_SERVICE;
  return null;
}

/** The definition this version would install on this platform. */
export function generateAutostartDefinition(): string {
  return process.platform === 'darwin' ? generateLaunchdPlist() : generateSystemdUnit();
}

/**
 * The definition currently on disk, or null when there is none (or it cannot be
 * read -- a definition we cannot read must not be reported as differing, and
 * must not be silently overwritten either; the caller treats null as absent and
 * writing then fails loudly).
 */
export function readInstalledAutostart(path: string | null = getAutostartPath()): string | null {
  if (path === null) return null;
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Override files that change the effective definition, i.e. systemd drop-ins in
 * `<unit>.d/*.conf`. Always empty for launchd, which has no such mechanism.
 *
 * Worth surfacing because everything else here reads the main file only, and
 * checkInstalledSystemdUnit goes silent entirely once a drop-in exists: without
 * this, `jarvis autostart --status` would report a unit as current while an
 * override quietly put `Restart=always` back.
 */
export function getAutostartDropIns(path: string | null = getAutostartPath()): string[] {
  if (path === null || process.platform !== 'linux') return [];
  try {
    const dir = `${path}.d`;
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((f) => f.endsWith('.conf')).sort().map((f) => join(dir, f));
  } catch {
    return [];
  }
}

/**
 * Whether the installed definition is enabled, i.e. whether the manager starts
 * it by itself. `null` when that is not knowable: launchd has no equivalent of
 * `systemctl is-enabled` (a plist in ~/Library/LaunchAgents is loaded at login
 * by being there), and a systemctl that cannot answer must not be reported as a
 * no.
 */
export function readAutostartEnabled(spawnSync: SpawnSyncFn = defaultSpawnSync): boolean | null {
  if (process.platform !== 'linux') return null;
  try {
    const res = spawnSync(['systemctl', '--user', 'is-enabled', SYSTEMD_UNIT_NAME]);
    // Every state that means "systemd starts this by itself" exits 0: enabled,
    // enabled-runtime, static, indirect, generated, transient, alias.
    if (res.exitCode === 0) return true;
    // Non-zero covers two different things: a unit that really will not be
    // started by itself (systemctl prints the state word on STDOUT and nothing
    // else) and a user manager that could not be reached at all (an error on
    // stderr, which says nothing about the unit). Only the first is a `false`.
    // Matched against the whole first line of stdout rather than searched for
    // anywhere in the output, so a state word inside an error message cannot
    // turn "unknown" into "no".
    const word = decodeLaunchctlOutput(res.stdout).trim().split('\n')[0]?.trim().toLowerCase() ?? '';
    const OFF = ['disabled', 'masked', 'masked-runtime', 'linked', 'linked-runtime', 'bad', 'not-found'];
    return OFF.includes(word) ? false : null;
  } catch {
    return null;
  }
}

/**
 * Register an already-written definition with the service manager, without
 * touching the file.
 *
 * `installSystemd` writes, reloads and enables in that order, so a failure at
 * either of the last two steps leaves a byte-current unit that systemd will
 * never start (#548's review). This is the repair for that state, and it must not
 * go through the writer: the file is already the one we would write, and
 * rewriting it would drop whatever comments its owner added.
 *
 * launchd has no equivalent -- a plist in ~/Library/LaunchAgents is loaded at
 * login by being there -- so this is a no-op success off Linux, matching
 * readAutostartEnabled's `null`.
 */
export function enableAutostart(spawnSync: SpawnSyncFn = defaultSpawnSync): boolean {
  if (process.platform !== 'linux') return true;
  try {
    const reload = spawnSync(['systemctl', '--user', 'daemon-reload']);
    if (reload.exitCode !== 0) {
      printErr('Failed to reload systemd. You may need to run: systemctl --user daemon-reload');
      return false;
    }
    const enable = spawnSync(['systemctl', '--user', 'enable', SYSTEMD_UNIT_NAME]);
    if (enable.exitCode !== 0) {
      printErr(`Failed to enable the service. You may need to run: systemctl --user enable ${SYSTEMD_UNIT_NAME}`);
      return false;
    }
    printOk(`Enabled ${SYSTEMD_UNIT_NAME}.`);
    return true;
  } catch (err) {
    printErr(`Failed to enable the service: ${err}`);
    return false;
  }
}

/**
 * The lines of a definition that carry meaning, for comparing what is installed
 * with what we would write (src/cli/autostart-command.ts).
 *
 * Comments and blank lines are dropped, and systemd directives are normalised to
 * `[Section] KEY=value`, so indentation, ordering within a section and a
 * reworded comment are not differences -- only the directives are. A user's own
 * comment therefore never makes the command demand `--force`, and is never lost
 * to a rewrite that would change nothing.
 */
export function meaningfulAutostartLines(text: string, kind: AutostartKind): string[] {
  if (kind === 'systemd') {
    return parseUnitDirectives(text).map((d) => `[${d.section}] ${d.key}=${d.value}`);
  }
  const pairs = plistPairs(text);
  // A plist this cannot read at all falls back to its lines, which can only make
  // the comparison say "differs" -- the safe answer, since that writes nothing.
  return pairs.length > 0
    ? pairs
    : text.replace(/<!--[\s\S]*?-->/g, '').split('\n').map((line) => line.trim()).filter(Boolean);
}

/**
 * A plist flattened to `Path=value` pairs, e.g.
 * `KeepAlive.SuccessfulExit=<false/>` and `ProgramArguments[2]=start`.
 *
 * A bag of LINES cannot be used to compare two plists: key and value are
 * separate nodes, so a plist with `RunAtLoad=<false/>` and
 * `KeepAlive.SuccessfulExit=<true/>` -- an agent that never starts at login and
 * relaunches only after a CLEAN exit, i.e. #549 inverted -- holds exactly the
 * same lines as the correct one and compared equal (#548's review). Pairing each
 * key with the node that follows it removes that whole class, and gives the
 * diff `jarvis autostart` prints a name for each changed value instead of a
 * bare `<true/>`.
 *
 * Deliberately small: enough of the format for the files this writes and for a
 * hand-edited version of one. It never throws, and anything it cannot follow
 * makes it return fewer pairs, which shows up as a difference rather than as a
 * false "current".
 */
function plistPairs(text: string): string[] {
  const body = text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!DOCTYPE[^>]*>/g, '');

  const out: string[] = [];
  // One frame per open container. `key` is the key the next value belongs to in
  // a dict; `index` numbers the values of an array.
  const stack: { path: string; kind: 'dict' | 'array'; key: string | null; index: number }[] = [];
  const token = /<(\/?)([A-Za-z]+)([^>]*?)(\/?)>/g;
  let match: RegExpExecArray | null;

  const nameFor = (frame: typeof stack[number] | undefined, tag: string): string | null => {
    if (!frame) return tag === 'dict' || tag === 'array' ? '' : null;
    if (frame.kind === 'array') return `${frame.path}[${frame.index++}]`;
    if (frame.key === null) return null; // a value with no key before it
    const name = frame.path ? `${frame.path}.${frame.key}` : frame.key;
    frame.key = null;
    return name;
  };

  while ((match = token.exec(body)) !== null) {
    const closing = match[1] ?? '';
    const tag = match[2] ?? '';
    const selfClosing = match[4] ?? '';
    const frame = stack[stack.length - 1];

    if (closing) {
      if ((tag === 'dict' || tag === 'array') && stack.length > 0) {
        // Flush a key whose value never came before the container closed: the
        // LAST entry of a dict losing its value is the same half-deleted edit as
        // the two-keys-in-a-row case below, and must not compare equal to a file
        // that never had the key.
        if (frame && frame.kind === 'dict' && frame.key !== null) {
          out.push(`${frame.path ? `${frame.path}.` : ''}${frame.key}=<missing/>`);
        }
        stack.pop();
      }
      continue;
    }

    if (tag === 'key') {
      const end = body.indexOf('</key>', token.lastIndex);
      if (end === -1) break;
      if (frame && frame.kind === 'dict') {
        // Two keys in a row: the first has no value. Not a plist launchd would
        // load, but it has to be VISIBLE -- dropping it silently would let a
        // half-deleted entry compare equal to a file that never had it.
        if (frame.key !== null) out.push(`${frame.path ? `${frame.path}.` : ''}${frame.key}=<missing/>`);
        frame.key = body.slice(token.lastIndex, end).trim();
      }
      token.lastIndex = end + '</key>'.length;
      continue;
    }

    if (tag === 'plist') continue;

    if (tag === 'dict' || tag === 'array') {
      const name = nameFor(frame, tag);
      if (selfClosing) {
        if (name !== null) out.push(`${name}=<${tag}/>`);
      } else {
        stack.push({ path: name ?? '', kind: tag === 'dict' ? 'dict' : 'array', key: null, index: 0 });
      }
      continue;
    }

    // A scalar: <true/>, <false/>, <string>x</string>, <integer>1</integer>, ...
    const name = nameFor(frame, tag);
    let value = `<${tag}/>`;
    if (!selfClosing) {
      const end = body.indexOf(`</${tag}>`, token.lastIndex);
      if (end === -1) break;
      value = body.slice(token.lastIndex, end);
      token.lastIndex = end + `</${tag}>`.length;
    }
    if (name !== null) out.push(`${name}=${value}`);
  }

  // ...and once more for a dict the text never closed at all.
  for (const frame of stack) {
    if (frame.kind === 'dict' && frame.key !== null) {
      out.push(`${frame.path ? `${frame.path}.` : ''}${frame.key}=<missing/>`);
    }
  }

  return out;
}

/**
 * Install autostart for the current platform.
 */
export async function installAutostart(): Promise<boolean> {
  if (process.platform === 'darwin') {
    return installLaunchd();
  }
  return installSystemd();
}

export interface StartAutostartOptions {
  /**
   * The definition on disk was just written. On macOS that matters: `launchctl
   * bootstrap` on an agent launchd has already loaded is a no-op that keeps the
   * PREVIOUS definition, so the refresh would look like it worked while the old
   * plist stayed live (#548's review). Only pass true when nothing holds the
   * daemon lock: it boots the agent out first.
   */
  replaceLoaded?: boolean;
}

/**
 * Start the installed autostart service for the current platform.
 */
export async function startAutostartService(options: StartAutostartOptions = {}): Promise<boolean> {
  if (process.platform === 'darwin') {
    return startLaunchdService(options);
  }
  return startSystemdService();
}

/**
 * Schedule a restart of the installed autostart service without blocking
 * the current process. Useful when the API call is served by that service.
 */
export function scheduleAutostartRestart(): boolean {
  if (process.platform === 'darwin') {
    return scheduleLaunchdRestart();
  }
  if (process.platform === 'linux') {
    return scheduleSystemdRestart();
  }
  return false;
}

/**
 * Uninstall autostart for the current platform.
 */
export async function uninstallAutostart(): Promise<boolean> {
  if (process.platform === 'darwin') {
    return uninstallLaunchd();
  }
  return uninstallSystemd();
}

/**
 * Check if autostart is installed for the current platform.
 */
export function isAutostartInstalled(): boolean {
  if (process.platform === 'darwin') {
    return isLaunchdInstalled();
  }
  return isSystemdInstalled();
}

/**
 * Check whether the current platform can use the keepalive manager.
 * Linux and WSL2 require a reachable user systemd instance.
 */
export function isAutostartSupported(): boolean {
  return checkAutostartSupport().supported;
}

/**
 * Like isAutostartSupported, but returns why it isn't when the answer is no —
 * useful for surfacing real diagnostics (e.g., WSL2 bus unreachable) in onboarding.
 */
export function checkAutostartSupport(): SystemdProbeResult {
  if (process.platform === 'darwin') {
    return { supported: true };
  }
  return probeSystemdUserService();
}

/**
 * Get the name of the autostart mechanism for the current platform.
 */
export function getAutostartName(): string {
  if (process.platform === 'darwin') {
    return 'launchd (User Agent)';
  }
  return 'systemd (User Service)';
}

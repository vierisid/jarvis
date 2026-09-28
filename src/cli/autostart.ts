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
const SYSTEMD_SERVICE = join(SYSTEMD_DIR, 'jarvis.service');

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
    if (lingering.exitCode !== 0) {
      printWarn('Could not enable lingering. Service may stop when you log out.');
    }

    printOk(`Installed systemd service: ${SYSTEMD_SERVICE}`);
    printOk('Service will restart automatically and start on boot.');
    return true;
  } catch (err) {
    printErr(`Failed to install systemd service: ${err}`);
    return false;
  }
}

async function startSystemdService(): Promise<boolean> {
  try {
    // Same reason as in scheduleSystemdRestart: a unit sitting at its start
    // limit refuses the next start, and neither daemon-reload nor enable clears
    // the counter. Result ignored (a no-op on a healthy unit).
    Bun.spawnSync(['systemctl', '--user', 'reset-failed', 'jarvis.service']);
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

    if (existsSync(SYSTEMD_SERVICE)) {
      unlinkSync(SYSTEMD_SERVICE);
    }

    Bun.spawnSync(['systemctl', '--user', 'daemon-reload']);
    printOk('Uninstalled systemd service.');
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
export type AutostartProblem = 'opens-a-browser' | 'unbounded-restarts';

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
  if (execStart && !execTokens(execStart.value).includes('--no-open')) {
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
  }
}

// ── launchd (macOS) ──────────────────────────────────────────────────

const LAUNCHD_DIR = join(homedir(), 'Library', 'LaunchAgents');
const LAUNCHD_PLIST = join(LAUNCHD_DIR, 'ai.jarvis.daemon.plist');

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
  // --no-open for the same reason as the systemd unit (#544): KeepAlive=true
  // relaunches the daemon, and every relaunch would otherwise pop a browser tab.
  //
  // Two things the systemd half of #543 does that this does NOT, both
  // pre-existing and both needing a macOS box to change safely:
  //   - `KeepAlive=<true/>` relaunches on ANY exit, a clean one included, so a
  //     `jarvis stop` here is undone about ThrottleInterval (10s) later. The
  //     launchd equivalent of Restart=on-failure is a KeepAlive DICT with
  //     `SuccessfulExit=false`. src/cli/uninstall.ts already works around the
  //     current behavior by removing autostart before stopping the daemon.
  //   - launchd throttles respawns to ~10s but never gives up, so the crash-loop
  //     bound (StartLimitBurst) is Linux-only.

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ai.jarvis.daemon</string>
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
  <true/>
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
    printOk('Service will restart automatically and stay running after the terminal closes.');
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

function launchctlReason(result: SpawnResultLike): string {
  const combined = `${decodeLaunchctlOutput(result.stderr)}\n${decodeLaunchctlOutput(result.stdout)}`.trim();
  const first = combined.split('\n').find((line) => line.trim().length > 0);
  return (first ?? `exit ${result.exitCode}`).slice(0, 200);
}

async function startLaunchdService(): Promise<boolean> {
  try {
    const getuid = process.getuid;
    const uid = typeof getuid === 'function' ? getuid.call(process) : undefined;

    let bootstrapReason: string | null = null;
    if (typeof uid === 'number') {
      const bootstrap = Bun.spawnSync(['launchctl', 'bootstrap', `gui/${uid}`, LAUNCHD_PLIST]);
      if (bootstrap.exitCode === 0 || isLaunchdAlreadyLoaded(bootstrap)) {
        printOk('JARVIS launch agent is running.');
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

    printOk('JARVIS launch agent is running.');
    return true;
  } catch (err) {
    printWarn(`Installed launchd plist, but could not start it immediately: ${err}`);
    return false;
  }
}

function scheduleLaunchdRestart(): boolean {
  const uid = process.getuid?.();
  const command = uid != null
    ? `sleep 1; launchctl kickstart -k gui/${uid}/ai.jarvis.daemon >/dev/null 2>&1`
    : `sleep 1; launchctl kickstart -k gui/$(id -u)/ai.jarvis.daemon >/dev/null 2>&1`;
  return spawnDetachedShell(command, ['bash', 'launchctl']);
}

async function uninstallLaunchd(): Promise<boolean> {
  try {
    if (existsSync(LAUNCHD_PLIST)) {
      Bun.spawnSync(['launchctl', 'unload', LAUNCHD_PLIST]);
      unlinkSync(LAUNCHD_PLIST);
    }

    printOk('Uninstalled launchd plist.');
    return true;
  } catch (err) {
    printErr(`Failed to uninstall launchd plist: ${err}`);
    return false;
  }
}

function isLaunchdInstalled(): boolean {
  return existsSync(LAUNCHD_PLIST);
}

/**
 * The stale-install question (see checkInstalledSystemdUnit) for the launchd
 * plist: KeepAlive=true relaunches the daemon just as often.
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
  return argv.includes('<string>--no-open</string>') ? null : { path: plistPath, problems: ['opens-a-browser'] };
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

/**
 * Install autostart for the current platform.
 */
export async function installAutostart(): Promise<boolean> {
  if (process.platform === 'darwin') {
    return installLaunchd();
  }
  return installSystemd();
}

/**
 * Start the installed autostart service for the current platform.
 */
export async function startAutostartService(): Promise<boolean> {
  if (process.platform === 'darwin') {
    return startLaunchdService();
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

/**
 * Restart and update a daemon that runs as a systemd user unit through
 * systemd itself (#525).
 *
 * `jarvis restart` and `jarvis update` used to stop the daemon and start a new
 * one themselves. Under the unit the autostart installer writes
 * (Restart=on-failure, default KillMode=control-group) that goes wrong two ways:
 *
 *  - Run from inside the unit's cgroup (the assistant's run_command, a
 *    sub-agent, a workflow step), the CLI is part of the service. The daemon
 *    drains and exits 0, on-failure does not restart it, and systemd kills
 *    everything left in the cgroup, the CLI included, before it can start the
 *    replacement. Jarvis stays down, and an update never runs.
 *  - Run from a terminal, it works, but the replacement runs outside the unit:
 *    systemd shows the unit inactive, nothing restarts a crash, and the next
 *    `systemctl --user restart` starts a second daemon that loses the lock and
 *    crash-loops.
 *
 * So when the lock holder is a user unit's main process, systemd does the
 * work. From inside the cgroup even `systemctl --no-block` is too slow:
 * systemd SIGTERMs the whole cgroup, systemctl included, before it returns
 * (measured on systemd 262). Anything that must outlive the daemon therefore
 * runs as a transient unit of its own (`systemd-run`): a timer that runs
 * `systemctl restart`, or for `jarvis update` the whole stop/update/start. The
 * CLI returns first, so run_command still gets its output back. The daemon
 * itself is only ever started by its own unit, never by one of those
 * transients, so it always gets the unit's environment (#514).
 *
 * Restarting the unit SIGTERMs every process in its cgroup at once, the
 * daemon's children included. The daemon's own drain still lets the turn that
 * asked finish its reply, but a child process of another turn is not waited for.
 *
 * `jarvis stop` is deliberately not routed: a SIGTERMed daemon exits 0 and
 * leaves the unit inactive, exactly as `systemctl stop` would, and signalling
 * only the daemon keeps `drain`'s promise that in-flight child processes get
 * the drain window.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { c } from './helpers.ts';
import { getPidPath, isLocked } from '../daemon/pid.ts';

export interface SystemdUnit {
  /** The unit's name, e.g. `jarvis.service`. */
  name: string;
  /** The daemon's pid. Also the unit's MainPID when `reachable`. */
  pid: number;
  /** This process runs inside the unit's cgroup, so stopping the unit kills it. */
  inside: boolean;
  /**
   * False when the cgroups say we are inside the daemon's service but
   * `systemctl --user` could not be asked about it (no bus in this
   * environment). Nothing can be routed then, and the old path would be the
   * outage, so callers refuse. From outside the same failure is not flagged:
   * without systemctl, a daemon some unrelated service (a tmux.service)
   * merely spawned cannot be told apart, and refusing would block it for good.
   */
  reachable: boolean;
  /**
   * The unit was made by `systemd-run`: a stop unloads it, so it cannot be
   * started again afterwards.
   */
  transient?: boolean;
  /** The unit's TimeoutStopSec in ms (Infinity for `infinity`); null or absent when unknown. */
  stopTimeoutMs?: number | null;
}

export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (cmd: string[], options?: { timeoutMs?: number }) => CommandResult;

/**
 * Runs with the current env, so PATH is looked up at call time (Bun resolves
 * argv[0] against the PATH it started with unless handed an env). A child that
 * got a trimmed environment, such as the site builder's, has no
 * XDG_RUNTIME_DIR, and `systemctl --user` cannot find the manager without it.
 */
export const runCommand: CommandRunner = (cmd, options = {}) => {
  const env = { ...process.env };
  const uid = process.getuid?.();
  if (!env.XDG_RUNTIME_DIR && uid !== undefined && existsSync(`/run/user/${uid}`)) {
    env.XDG_RUNTIME_DIR = `/run/user/${uid}`;
  }
  try {
    const result = Bun.spawnSync(cmd, {
      stdout: 'pipe',
      stderr: 'pipe',
      env,
      timeout: options.timeoutMs ?? 15_000,
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  } catch (err) {
    // A missing binary throws rather than returning a status.
    return { exitCode: null, stdout: '', stderr: err instanceof Error ? err.message : String(err) };
  }
};

// No leading dash (it would read as an option). Instance and escaped names
// (`jarvis@x.service`, `a\x2db.service`) appear verbatim in cgroup paths and
// systemctl takes them as they are.
const UNIT_NAME = /^[A-Za-z0-9_:.@\\][A-Za-z0-9_:.@\\-]*\.service$/;

/**
 * The cgroup path systemd placed a process in, from the text of
 * /proc/<pid>/cgroup. Prefers the unified (v2) line. On a legacy host that
 * line is present but reads `0::/`, so it falls back to `name=systemd`.
 */
export function parseCgroupPath(text: string): string | null {
  const lines = text.split('\n');
  const unified = lines.find((line) => line.startsWith('0::'));
  const legacy = lines.find((line) => /^\d+:name=systemd:/.test(line));
  for (const line of [unified, legacy]) {
    if (!line) continue;
    const path = line.slice(line.indexOf(':', line.indexOf(':') + 1) + 1).trim();
    if (path.startsWith('/') && path !== '/') return path;
  }
  return null;
}

/**
 * The user unit a cgroup path belongs to: the innermost `.service` below
 * `user@<uid>.service`, the manager `systemctl --user` talks to. Walking up
 * rather than reading the leaf covers a unit with Delegate= sub-cgroups.
 * Returns the unit's own cgroup too, which is what "inside" is measured
 * against. System units, scopes (a terminal's session-*.scope or app-*.scope)
 * and another user's manager give null.
 */
export function userUnitFromCgroup(path: string, uid: number): { name: string; cgroup: string } | null {
  const segments = path.split('/').filter(Boolean);
  const manager = segments.indexOf(`user@${uid}.service`);
  if (manager === -1) return null;
  for (let i = segments.length - 1; i > manager; i -= 1) {
    if (UNIT_NAME.test(segments[i]!)) {
      return { name: segments[i]!, cgroup: `/${segments.slice(0, i + 1).join('/')}` };
    }
  }
  return null;
}

/** The parent pid, from /proc/<pid>/stat (the field after the `)` of the command name). */
function readParentPid(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
    const ppid = Number.parseInt(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1] ?? '', 10);
    return Number.isInteger(ppid) && ppid > 0 ? ppid : null;
  } catch {
    return null;
  }
}

function readProcCgroup(pid: number | 'self'): string | null {
  try {
    return readFileSync(`/proc/${pid}/cgroup`, 'utf-8');
  } catch {
    return null;
  }
}

export interface DetectOptions {
  /** Defaults to the lock holder (isLocked()). */
  lockHolder?: () => number | null;
  readCgroup?: (pid: number | 'self') => string | null;
  /** Defaults to reading /proc/<pid>/stat. */
  parentPid?: (pid: number) => number | null;
  run?: CommandRunner;
  platform?: NodeJS.Platform;
  uid?: number;
}

interface UnitInfo {
  /** 0 when the unit has no main process. */
  mainPid: number;
  transient: boolean;
  /** The unit's cgroup, e.g. `/user.slice/.../jarvis.service`; null when it has none. */
  cgroup: string | null;
  /** TimeoutStopSec in ms; null when unset or unparseable, Infinity for `infinity`. */
  stopTimeoutMs: number | null;
}

/**
 * What systemd says about a unit; null when systemctl could not say. Parses
 * `KEY=value` lines rather than using `--value`, which needs systemd 230.
 */
function unitInfo(unit: string, run: CommandRunner): UnitInfo | null {
  const show = run([
    'systemctl', '--user', 'show', unit,
    '--property=MainPID', '--property=Transient', '--property=ControlGroup', '--property=TimeoutStopUSec',
  ]);
  if (show.exitCode !== 0) return null;
  const values = new Map<string, string>();
  for (const line of show.stdout.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) values.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  const pid = Number.parseInt(values.get('MainPID') ?? '', 10);
  if (!Number.isInteger(pid) || pid < 0) return null;
  return {
    mainPid: pid,
    transient: values.get('Transient') === 'yes',
    cgroup: values.get('ControlGroup') || null,
    stopTimeoutMs: parseTimespanMs(values.get('TimeoutStopUSec') ?? ''),
  };
}

const TIMESPAN_UNITS: Record<string, number> = {
  us: 0.001, usec: 0.001, ms: 1, msec: 1, s: 1000, sec: 1000, '': 1000,
  m: 60_000, min: 60_000, h: 3_600_000, hr: 3_600_000, d: 86_400_000, w: 604_800_000,
  M: 2_629_800_000, month: 2_629_800_000, y: 31_557_600_000,
};

/** A systemd time span as `systemctl show` prints it (`1min 30s`, `infinity`) in ms, or null. */
export function parseTimespanMs(text: string): number | null {
  const value = text.trim();
  if (value === 'infinity') return Infinity;
  if (!value) return null;
  let total = 0;
  for (const part of value.split(/\s+/)) {
    const match = /^(\d+(?:\.\d+)?)([a-z]*)$/.exec(part);
    const unit = match ? TIMESPAN_UNITS[match[2]!] : undefined;
    if (!match || unit === undefined) return null;
    total += Number.parseFloat(match[1]!) * unit;
  }
  return total;
}

/**
 * The systemd user unit the running daemon is the main process of, or null
 * when it is not one: not running, started by hand, a system unit, not Linux.
 *
 * The daemon is the lock holder, never a pid a caller passes in, and systemd
 * must name that same pid as the unit's MainPID. That keeps a daemon some
 * other service merely spawned (a tmux.service, a desktop app) from getting
 * that whole service restarted; such a daemon takes the old path.
 */
export function detectSystemdUnit(options: DetectOptions = {}): SystemdUnit | null {
  if ((options.platform ?? process.platform) !== 'linux') return null;
  const uid = options.uid ?? process.getuid?.();
  if (uid === undefined) return null;

  const pid = (options.lockHolder ?? isLocked)();
  if (!pid) return null;

  const readCgroup = options.readCgroup ?? readProcCgroup;
  const daemonText = readCgroup(pid);
  const daemonPath = daemonText ? parseCgroupPath(daemonText) : null;
  const unit = daemonPath ? userUnitFromCgroup(daemonPath, uid) : null;
  if (!unit) return null;

  // Our own cgroup unreadable: assume inside. Every inside path is also safe
  // from outside, while the reverse is the outage.
  const selfText = readCgroup('self');
  const selfPath = selfText ? parseCgroupPath(selfText) : null;
  const inside = selfPath === null
    || selfPath === unit.cgroup || selfPath.startsWith(`${unit.cgroup}/`);

  const info = unitInfo(unit.name, options.run ?? runCommand);
  if (info === null) {
    // Without systemctl, MainPID cannot be checked. Inside the unit the old
    // path is the outage, so refuse. Outside, tell the unit's own main process
    // (started by the user manager itself, whose cgroup is its init.scope)
    // from a daemon that an unrelated service (a tmux.service) merely spawned:
    // the first must not be stopped and restarted by hand (it would come back
    // outside the unit, with this shell's environment, #514); the second takes
    // the old path, or it could never be restarted while systemctl is down.
    const ppid = (options.parentPid ?? readParentPid)(pid);
    const parentText = ppid ? readCgroup(ppid) : null;
    const parentPath = parentText ? parseCgroupPath(parentText) : null;
    const byManager = parentPath !== null && parentPath.endsWith(`/user@${uid}.service/init.scope`);
    return inside || byManager ? { name: unit.name, pid, inside, reachable: false } : null;
  }
  if (info.mainPid !== pid) return null;
  return { name: unit.name, pid, inside, reachable: true, transient: info.transient, stopTimeoutMs: info.stopTimeoutMs };
}

/** How long the transient timer waits before restarting the unit. */
export const SCHEDULE_DELAY_SEC = 2;

function describeFailure(result: CommandResult): string {
  const text = (result.stderr.trim() || result.stdout.trim()).split('\n')[0] ?? '';
  const status = result.exitCode === null ? 'did not run' : `exit ${result.exitCode}`;
  return text ? `${text} (${status})` : status;
}

/** Transient unit names derive from the service's, e.g. `jarvis-restart`. */
function transientName(unit: SystemdUnit, purpose: 'restart' | 'update'): string {
  return `${unit.name.replace(/\.service$/, '').replace(/[^A-Za-z0-9_-]/g, '-')}-${purpose}`;
}

/**
 * A fixed transient name makes a second request while the first is pending
 * fail with "already loaded" instead of queuing a second restart that would
 * bounce the fresh daemon. That failure means the work is already scheduled.
 */
function alreadyScheduled(result: CommandResult): boolean {
  return result.exitCode !== 0 && /already (loaded|exists|active)/i.test(`${result.stderr}\n${result.stdout}`);
}

function refuseUnreachable(unit: SystemdUnit, manual: string): false {
  console.error(c.red(`✗ JARVIS runs under ${unit.name}, and systemd cannot be reached from here.`));
  console.error(c.dim(unit.inside
    ? '  Stopping the daemon from here would end this command before it could start a new one.'
    : '  Stopping and starting it by hand would take it out of the service.'));
  console.error(c.dim(`  JARVIS was left running. From a login shell of this user: ${manual}`));
  return false;
}

/**
 * Ask systemd to restart the unit a moment from now, from a transient timer
 * that runs outside the unit's cgroup: for a caller inside that cgroup, which
 * a restart it waited on would kill.
 */
export function scheduleUnitRestart(unit: SystemdUnit, run: CommandRunner = runCommand): CommandResult {
  return run([
    'systemd-run', '--user', '--quiet', '--collect',
    `--unit=${transientName(unit, 'restart')}`,
    `--description=Restart ${unit.name} (jarvis restart)`,
    `--on-active=${SCHEDULE_DELAY_SEC}s`,
    // A timer's default accuracy is a minute.
    '--timer-property=AccuracySec=100ms',
    '--timer-property=RemainAfterElapse=no',
    // Resolved here: the transient service gets the manager's PATH.
    Bun.which('systemctl', { PATH: process.env.PATH ?? '' }) ?? 'systemctl',
    '--user', 'restart', unit.name,
  ]);
}

function unitState(unit: string, run: CommandRunner): { state: string; pid: number | null } {
  const show = run(['systemctl', '--user', 'show', unit, '--property=ActiveState', '--property=MainPID']);
  let state = 'unknown';
  let pid: number | null = null;
  for (const line of show.stdout.split('\n')) {
    const eq = line.indexOf('=');
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1).trim();
    if (key === 'ActiveState') state = value;
    if (key === 'MainPID') {
      const n = Number.parseInt(value, 10);
      pid = Number.isInteger(n) && n > 0 ? n : null;
    }
  }
  return { state, pid };
}

export interface WaitOptions {
  run?: CommandRunner;
  lockHolder?: () => number | null;
  /**
   * Bound on waiting for the new daemon. Under the 30 s after which a sidecar
   * stops waiting for a command, so the answer still reaches the assistant.
   */
  waitMs?: number;
  pollMs?: number;
}

/**
 * Wait for systemd's new main process (not `oldPid`) to hold the daemon lock,
 * the same signal `jarvis start -d` waits for. MainPID alone is set as soon
 * as systemd forks, before the daemon has started. Prints the outcome.
 */
async function waitForNewDaemon(unit: SystemdUnit, oldPid: number | null, options: WaitOptions): Promise<boolean> {
  const run = options.run ?? runCommand;
  const lockHolder = options.lockHolder ?? isLocked;
  const waitMs = options.waitMs ?? 20_000;
  const pollMs = options.pollMs ?? 250;
  const deadline = Date.now() + waitMs;
  let last: { state: string; pid: number | null } = { state: 'unknown', pid: null };
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    last = unitState(unit.name, run);
    if (last.state === 'active' && last.pid !== null && last.pid !== oldPid && lockHolder() === last.pid) {
      console.log(c.green(`✓ JARVIS is running under systemd (${unit.name}, PID ${last.pid}).`));
      return true;
    }
  }

  if (last.state === 'deactivating') {
    console.log(c.yellow(`JARVIS is still draining in-flight work; systemd finishes restarting ${unit.name} when it is done.`));
    console.log(c.dim('  Check with: jarvis status'));
    return true;
  }
  if (last.state === 'active' && last.pid !== null && last.pid !== oldPid) {
    console.log(c.yellow(`JARVIS was started by systemd (${unit.name}, PID ${last.pid}) and is still starting up.`));
    console.log(c.dim('  Check with: jarvis status'));
    return true;
  }
  console.error(c.red(`✗ ${unit.name} did not come back within ${Math.round(waitMs / 1000)}s (state: ${last.state}).`));
  console.error(c.dim(`  See: journalctl --user -u ${unit.name}`));
  return false;
}

export interface RestartOptions extends WaitOptions {
  /** `jarvis restart` arguments, which the unit's ExecStart overrides. */
  ignoredArgs?: string[];
}

/**
 * Restart the daemon through its systemd unit. Prints progress; returns false
 * when the restart could not be requested or did not come back. A request
 * that fails never touches the daemon, so failing leaves Jarvis running.
 */
export async function restartSystemdUnit(unit: SystemdUnit, options: RestartOptions = {}): Promise<boolean> {
  const run = options.run ?? runCommand;
  const manual = `systemctl --user restart ${unit.name}`;

  if (options.ignoredArgs && options.ignoredArgs.length > 0) {
    console.log(c.dim(`  Ignoring ${options.ignoredArgs.join(' ')}: ${unit.name} decides how JARVIS starts.`));
  }
  if (!unit.reachable) return refuseUnreachable(unit, manual);

  if (unit.inside) {
    const scheduled = scheduleUnitRestart(unit, run);
    if (alreadyScheduled(scheduled)) {
      console.log(c.green(`✓ A restart of ${unit.name} is already scheduled.`));
      return true;
    }
    if (scheduled.exitCode !== 0) {
      console.error(c.red(`✗ Could not schedule a restart of ${unit.name}: ${describeFailure(scheduled)}`));
      console.error(c.dim(`  JARVIS was left running. From a terminal: ${manual}`));
      return false;
    }
    console.log(c.green(`✓ Restart scheduled: systemd restarts ${unit.name} in ${SCHEDULE_DELAY_SEC}s.`));
    console.log(c.dim('  This command runs inside the service, so it does not wait for the new daemon.'));
    console.log(c.dim('  Check afterwards with: jarvis status'));
    return true;
  }

  // Outside the unit (a terminal, or a sidecar's shell). --no-block and a
  // bounded wait rather than a blocking restart: from a sidecar this CLI is
  // part of a turn, and the daemon's drain waits for that turn.
  const before = unitState(unit.name, run);
  if (before.state === 'deactivating' || before.state === 'activating') {
    console.log(c.cyan(`${unit.name} is already ${before.state}; waiting for it...`));
  } else {
    console.log(c.cyan(`Restarting JARVIS through systemd (${unit.name}, PID ${unit.pid})...`));
    const request = run(['systemctl', '--user', '--no-block', 'restart', unit.name]);
    if (request.exitCode !== 0) {
      console.error(c.red(`✗ systemctl could not restart ${unit.name}: ${describeFailure(request)}`));
      return false;
    }
  }
  return waitForNewDaemon(unit, unit.pid, options);
}

export interface RouteRestartDeps {
  detect?: () => SystemdUnit | null;
  restart?: (unit: SystemdUnit, options: RestartOptions) => Promise<boolean>;
}

/**
 * `jarvis restart`'s routing: `'legacy'` when the daemon is not a systemd
 * user unit's main process, so the caller stops and starts it itself;
 * otherwise systemd restarts it, and the answer is whether that worked. The
 * caller must never fall through to its own stop/start for a unit.
 */
export async function routeRestart(args: string[], deps: RouteRestartDeps = {}): Promise<'legacy' | 'done' | 'failed'> {
  const unit = (deps.detect ?? detectSystemdUnit)();
  if (!unit) return 'legacy';
  return await (deps.restart ?? restartSystemdUnit)(unit, { ignoredArgs: args }) ? 'done' : 'failed';
}

/**
 * Set on the transient updater to the unit it must stop and start. It never
 * falls back to stopping the daemon itself and spawning a detached one: that
 * daemon would get the updater's environment instead of the unit's own
 * Environment=/EnvironmentFile= (the workflow key among them, #514).
 */
export const UPDATE_UNIT_ENV = 'JARVIS_UPDATE_UNIT';

export interface DelegatedOptions {
  run?: CommandRunner;
  env?: Record<string, string | undefined>;
  readCgroup?: (pid: number | 'self') => string | null;
}

/**
 * The unit a transient updater was started for (see UPDATE_UNIT_ENV), or null
 * when this is not one. 'mismatch' when it must not go ahead: the running
 * daemon is not that unit's main process (it would stop some other unit),
 * systemd cannot be asked, or this process runs inside the unit itself (the
 * stop would kill it half way; a real updater never does, so the variable
 * came from somewhere else).
 */
export function delegatedUpdateUnit(runningPid: number | null, options: DelegatedOptions = {}): SystemdUnit | 'mismatch' | null {
  const name = (options.env ?? process.env)[UPDATE_UNIT_ENV];
  if (!name) return null;
  if (!UNIT_NAME.test(name)) {
    console.error(c.red(`✗ ${UPDATE_UNIT_ENV}=${name} is not a service name.`));
    return 'mismatch';
  }
  const info = unitInfo(name, options.run ?? runCommand);
  if (info === null) {
    console.error(c.red(`✗ Cannot ask systemd about ${name}; not stopping it.`));
    return 'mismatch';
  }
  if (runningPid && info.mainPid !== runningPid) {
    console.error(c.red(`✗ The running daemon (PID ${runningPid}) is not the main process of ${name}; not stopping it.`));
    return 'mismatch';
  }
  const selfText = (options.readCgroup ?? readProcCgroup)('self');
  const selfPath = selfText ? parseCgroupPath(selfText) : null;
  if (info.cgroup && selfPath && (selfPath === info.cgroup || selfPath.startsWith(`${info.cgroup}/`))) {
    console.error(c.red(`✗ ${UPDATE_UNIT_ENV} is set, but this runs inside ${name}: stopping it would end this update half way.`));
    return 'mismatch';
  }
  return { name, pid: runningPid ?? 0, inside: false, reachable: true, stopTimeoutMs: info.stopTimeoutMs };
}

/**
 * Variables `jarvis update` needs to find bun, git, the install and the data
 * root, and to get through a proxy, a private registry or a private CA. A
 * transient unit starts from the user manager's environment, not ours, so
 * these are passed explicitly. Nothing else is: no secrets from the daemon's
 * environment, and no registry tokens (NPM_TOKEN, `npm_config__authToken`,
 * BUN_CONFIG_TOKEN): a token belongs in the user's .npmrc/bunfig, which the
 * updater reads from HOME anyway.
 *
 * They are passed by name (`--setenv=KEY`), which systemd-run fills in from
 * its own environment, so values such as a proxy URL with credentials never
 * appear on a command line.
 */
export const UPDATE_ENV = [
  'PATH', 'HOME', 'JARVIS_HOME', 'BUN_INSTALL', 'JARVIS_INSTALL_METHOD',
  'LANG', 'LC_ALL', 'TMPDIR', 'XDG_CONFIG_HOME',
  'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'NPM_CONFIG_REGISTRY', 'BUN_CONFIG_REGISTRY',
  'npm_config_registry', 'npm_config_proxy', 'npm_config_https_proxy', 'npm_config_noproxy', 'npm_config_cafile',
];

const ACTIVE_STATES = new Set(['active', 'activating', 'deactivating', 'reloading']);

/**
 * Bound on each install step (`bun update -g`, `git fetch`, `bun install`):
 * a hung one fails the update instead of holding Jarvis down.
 */
export const INSTALL_STEP_TIMEOUT_MS = 10 * 60_000;

/** Bound on all install steps together; the updater's RuntimeMaxSec leaves room for it. */
export const INSTALL_BUDGET_MS = 30 * 60_000;

/**
 * How long to wait on `systemctl stop`: the unit's own TimeoutStopSec (90 s
 * unless set) plus 30 s, at least 3 minutes, and the timeout counts as an
 * hour at most.
 */
export function stopBudgetMs(unit: Pick<SystemdUnit, 'stopTimeoutMs'>): number {
  const timeout = unit.stopTimeoutMs ?? 90_000;
  return Math.max(180_000, Math.min(timeout, 3_600_000) + 30_000);
}

/**
 * RuntimeMaxSec for the transient updater: the stop, 30 minutes for the
 * install steps, and the start. Past it systemd kills the updater, and its
 * ExecStopPost starts Jarvis again.
 */
export function updaterRuntimeMaxSec(unit: Pick<SystemdUnit, 'stopTimeoutMs'>): number {
  return Math.ceil((stopBudgetMs(unit) + INSTALL_BUDGET_MS + 2 * 60_000) / 1000);
}

/**
 * One argument of an Exec*= line. systemd reads C escapes in it, so the
 * `\x2d` of an escaped unit name must reach it as `\\x2d`, or it starts a
 * different unit; `$` would expand a variable; quoted, so a space in the
 * systemctl path survives. (No `%` doubling: systemd-run's transient
 * properties get no specifier expansion.)
 */
function execArg(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '$$$$')}"`;
}

/**
 * Set on the transient updater to a random id it copies into its record, so
 * the terminal that started it reads this run's result and never an older one.
 */
export const UPDATE_RUN_ENV = 'JARVIS_UPDATE_RUN';

/** The result of the last update run by a transient updater, for `jarvis status`. */
export interface LastUpdate {
  outcome: 'updated' | 'up-to-date' | 'failed';
  from: string;
  to: string | null;
  /** ISO time the updater finished. */
  at: string;
  unit: string;
  /** UPDATE_RUN_ENV of the updater that wrote it. */
  run?: string;
  /** Whether the service was running again when the updater finished. */
  serviceStarted: boolean;
  error?: string;
}

export function lastUpdatePath(): string {
  return join(dirname(getPidPath()), 'last-update.json');
}

/** Best effort: a record that cannot be written must not fail the update. */
export function writeLastUpdate(record: LastUpdate): void {
  try {
    const path = lastUpdatePath();
    writeFileSync(`${path}.tmp`, `${JSON.stringify(record, null, 2)}\n`, 'utf-8');
    renameSync(`${path}.tmp`, path);
  } catch {
    // The journal still has the whole run.
  }
}

export function readLastUpdate(): LastUpdate | null {
  try {
    const record = JSON.parse(readFileSync(lastUpdatePath(), 'utf-8')) as LastUpdate;
    return typeof record?.outcome === 'string' && typeof record.at === 'string' ? record : null;
  } catch {
    return null;
  }
}

/** One line for `jarvis status`. */
export function describeLastUpdate(record: LastUpdate): string {
  const date = new Date(record.at);
  const when = Number.isNaN(date.getTime()) ? '' : ` (${date.toLocaleString()})`;
  const back = record.serviceStarted ? '' : `, and ${record.unit} did not come back`;
  return `Last update: ${updateSummary(record)}${back}${when}`;
}

function updateSummary(record: LastUpdate): string {
  const versions = record.to && record.to !== record.from ? `${record.from} → ${record.to}` : record.from;
  if (record.outcome === 'failed') return `failed (${versions})${record.error ? `: ${record.error}` : ''}`;
  return record.outcome === 'up-to-date' ? `already up to date (${versions})` : `updated ${versions}`;
}

/** The major version `systemd-run --version` reports, 0 when it cannot tell. */
function systemdVersion(run: CommandRunner): number {
  const out = run(['systemd-run', '--version']).stdout;
  const match = /^systemd (\d+)/m.exec(out);
  return match ? Number(match[1]) : 0;
}

export interface UpdateThroughSystemdOptions extends WaitOptions {
  /**
   * Follow the updater to the end. Defaults to stdout being a terminal: from
   * a sidecar's shell the updater's stop waits on the drain, the drain on the
   * turn running this command, so waiting here would only end in the
   * sidecar's timeout.
   */
  follow?: boolean;
  /** How long to follow the updater before leaving it to run. */
  followMs?: number;
  /** Override for the updater's RuntimeMaxSec (tests). */
  runtimeMaxSec?: number;
}

/**
 * Run the whole update as a transient unit, which stops the service, updates,
 * and starts it again from outside the service's cgroup. Stopping the unit
 * from this process instead fails two ways: inside the cgroup (the
 * assistant's run_command) the stop kills this command; outside it (a
 * terminal, a sidecar's shell) this command can still die before its start
 * (Ctrl-C, or the sidecar's 30 s timeout while the stop waits on the drain,
 * which waits on the very turn running us), and the unit stays down.
 *
 * ExecStopPost starts the service whenever the updater ends, however it ends:
 * after a normal run that is a no-op, and a killed, crashed or hung updater
 * (RuntimeMaxSec) cannot leave Jarvis down. Either way the daemon is started
 * by its own unit. A consequence: a `jarvis stop` or `systemctl --user stop`
 * issued while an update runs is overridden when the updater ends.
 *
 * Inside the cgroup this returns at once. Outside, it follows the updater's
 * journal until it finishes. No --collect: a failed updater stays loaded so
 * its result can be read, and it is reset before the next run.
 */
export async function updateThroughSystemd(
  unit: SystemdUnit,
  packageRoot: string,
  options: UpdateThroughSystemdOptions = {},
): Promise<'started' | 'done' | 'failed'> {
  const run = options.run ?? runCommand;
  const name = transientName(unit, 'update');
  if (!unit.reachable) {
    refuseUnreachable(unit, 'jarvis update');
    return 'failed';
  }
  if (unit.transient) {
    console.error(c.red(`✗ ${unit.name} is a transient unit: stopping it for the update would unload it for good.`));
    console.error(c.dim('  Stop JARVIS, run jarvis update, and start it again the way you started it.'));
    return 'failed';
  }

  const systemctl = Bun.which('systemctl', { PATH: process.env.PATH ?? '' }) ?? 'systemctl';
  // By name where systemd-run can copy the value itself (systemd 250+), so a
  // proxy password stays off the command line; older versions need KEY=VALUE.
  const byName = systemdVersion(run) >= 250;
  const env = UPDATE_ENV
    .filter((key) => process.env[key] !== undefined && process.env[key] !== '')
    .map((key) => (byName ? `--setenv=${key}` : `--setenv=${key}=${process.env[key]}`));
  run(['systemctl', '--user', 'reset-failed', `${name}.service`]);
  const runId = randomBytes(8).toString('hex');
  const result = run([
    'systemd-run', '--user', '--quiet',
    `--unit=${name}`,
    `--description=Update JARVIS (${unit.name})`,
    `--property=RuntimeMaxSec=${options.runtimeMaxSec ?? updaterRuntimeMaxSec(unit)}`,
    `--property=ExecStopPost=${[systemctl, '--user', '--no-block', 'start', unit.name].map(execArg).join(' ')}`,
    `--setenv=${UPDATE_UNIT_ENV}=${unit.name}`,
    `--setenv=${UPDATE_RUN_ENV}=${runId}`,
    ...env,
    process.execPath, join(packageRoot, 'bin', 'jarvis.ts'), 'update',
  ]);
  if (alreadyScheduled(result)) {
    console.log(c.green(`✓ An update is already running as ${name}.`));
    return 'started';
  }
  if (result.exitCode !== 0) {
    console.error(c.red(`✗ Could not start the update outside ${unit.name}: ${describeFailure(result)}`));
    console.error(c.dim('  Nothing was changed and JARVIS was left running.'));
    return 'failed';
  }

  if (unit.inside || !(options.follow ?? process.stdout.isTTY === true)) {
    console.log(c.green(`✓ Update started as ${name}, outside ${unit.name}.`));
    console.log(c.dim('  It stops JARVIS, installs the update, and starts JARVIS again.'));
    console.log(c.dim(`  Follow it with: journalctl --user -u ${name} -f`));
    console.log(c.dim('  The result shows in: jarvis status'));
    return 'started';
  }

  console.log(c.dim(`  Running the update as ${name}, which stops and restarts ${unit.name}.`));
  console.log(c.dim('  Ctrl-C stops following it; the update itself carries on.\n'));
  let journal: ReturnType<typeof Bun.spawn> | null = null;
  try {
    journal = Bun.spawn(['journalctl', '--user', '-f', '-o', 'cat', '-u', `${name}.service`, `--since=@${Math.floor(Date.now() / 1000) - 1}`], {
      stdio: ['ignore', 'inherit', 'ignore'],
      env: { ...process.env },
    });
  } catch {
    // No journal to show; the outcome below is still reported.
  }
  const deadline = Date.now() + (options.followMs ?? ((options.runtimeMaxSec ?? updaterRuntimeMaxSec(unit)) + 60) * 1000);
  const pollMs = options.pollMs ?? 500;
  let state = unitState(`${name}.service`, run).state;
  while (ACTIVE_STATES.has(state) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    state = unitState(`${name}.service`, run).state;
  }
  // Give the journal a moment to print the updater's last lines.
  await new Promise((resolve) => setTimeout(resolve, Math.min(1000, pollMs * 2)));
  journal?.kill();
  await journal?.exited;

  if (ACTIVE_STATES.has(state)) {
    console.log(c.yellow(`\n${name} is still running; follow it with: journalctl --user -u ${name} -f`));
    return 'started';
  }

  // The updater's own record says what happened; the unit's state alone
  // cannot tell a failed install from a service that did not come back.
  const found = readLastUpdate();
  const record = found?.run === runId ? found : null;
  if (state === 'failed') run(['systemctl', '--user', 'reset-failed', `${name}.service`]);
  if (!record) {
    console.error(c.red(state === 'failed'
      ? `\n✗ The update did not finish (killed or timed out); systemd starts ${unit.name} again.`
      : `\n✗ The update ended without leaving its result (${lastUpdatePath()}).`));
    console.error(c.dim(`  See: journalctl --user -u ${name}`));
    return 'failed';
  }
  if (record.outcome === 'failed') {
    console.error(c.red(`\n✗ The update failed${record.error ? `: ${record.error}` : ''}. See: journalctl --user -u ${name}`));
    return 'failed';
  }
  const service = unitState(unit.name, run);
  if (!record.serviceStarted || (service.state !== 'active' && service.state !== 'reloading')) {
    console.error(c.red(`\n✗ The update was installed, but ${unit.name} is ${service.state}. See: journalctl --user -u ${unit.name}`));
    return 'failed';
  }
  const summary = updateSummary(record);
  console.log(c.green(`\n✓ ${summary[0]!.toUpperCase()}${summary.slice(1)}; ${unit.name} is running${service.pid ? ` (PID ${service.pid})` : ''}.`));
  return 'done';
}

/**
 * Stop the unit and wait for it, the drain included. On failure the stop may
 * still be under way inside systemd, so a start is queued behind it: the unit
 * must not be left down by an update that never ran.
 */
export function stopSystemdUnit(unit: SystemdUnit, run: CommandRunner = runCommand): boolean {
  console.log(c.dim(`  Stopping ${unit.name}${unit.pid > 0 ? ` (PID ${unit.pid})` : ''} before update...`));
  const result = run(['systemctl', '--user', 'stop', unit.name], { timeoutMs: stopBudgetMs(unit) });
  if (result.exitCode !== 0) {
    console.error(c.red(`✗ systemctl could not stop ${unit.name}: ${describeFailure(result)}`));
    console.error(c.dim('  Nothing was updated.'));
    run(['systemctl', '--user', '--no-block', 'start', unit.name]);
    return false;
  }
  return true;
}

/** Start the unit and wait for its daemon. Prints the outcome. */
export async function startSystemdUnit(unit: SystemdUnit, options: WaitOptions = {}): Promise<boolean> {
  const run = options.run ?? runCommand;
  const result = run(['systemctl', '--user', 'start', unit.name], { timeoutMs: 60_000 });
  if (result.exitCode !== 0) {
    console.error(c.red(`✗ systemctl could not start ${unit.name}: ${describeFailure(result)}`));
    console.error(c.dim(`  Start it with: systemctl --user start ${unit.name}`));
    return false;
  }
  return waitForNewDaemon(unit, unit.pid, options);
}

import { existsSync, readFileSync, readlinkSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import os from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import YAML from 'yaml';
import { readLockedPort, isProcessAlive, getPidPath } from '../daemon/pid.ts';
import { readPortSetting, type PortSetting } from '../config/port.ts';
import { win32SystemExe } from '../util/system-exe.ts';

export const DEFAULT_DAEMON_PORT = 3142;

function parsePidList(output: string, currentPid: number): number[] {
  return [...new Set(
    output
      .split(/\r?\n/)
      .flatMap((line) => line.match(/\d+/g) ?? [])
      .map((value) => Number.parseInt(value, 10))
      .filter((value) => Number.isInteger(value) && value > 0 && value !== currentPid)
  )];
}

// Re-exported under the local name this module already uses. The EPERM-vs-ESRCH
// distinction lives in one place now (pid.ts) — this file used to have its own
// copy that reported another user's listener as dead, so ensurePortReleased
// skipped it silently.
const isPidAlive = isProcessAlive;

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return !isPidAlive(pid);
}

async function captureOutput(command: string[], quiet = true): Promise<string> {
  const proc = Bun.spawn(command, {
    stdout: 'pipe',
    stderr: quiet ? 'ignore' : 'pipe',
  });
  const output = await new Response(proc.stdout).text();
  await proc.exited;
  return output;
}

async function findListeningPids(port: number, currentPid: number): Promise<number[]> {
  if (os.platform() === 'win32') {
    const output = await captureOutput([
      win32SystemExe('powershell.exe'),
      '-NoProfile',
      '-Command',
      `(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess) -join "\\n"`,
    ]);
    return parsePidList(output, currentPid);
  }

  const lsofOutput = await captureOutput([
    'bash',
    '-lc',
    `lsof -ti tcp:${port} -sTCP:LISTEN 2>/dev/null || true`,
  ]);
  const lsofPids = parsePidList(lsofOutput, currentPid);
  if (lsofPids.length > 0) return lsofPids;

  const ssOutput = await captureOutput([
    'bash',
    '-lc',
    `ss -ltnp '( sport = :${port} )' 2>/dev/null || true`,
  ]);
  return [...new Set(
    Array.from(ssOutput.matchAll(/pid=(\d+)/g))
      .map((match) => Number.parseInt(match[1]!, 10))
      .filter((value) => Number.isInteger(value) && value > 0 && value !== currentPid)
  )];
}

/** The `bin/jarvis.ts` of THIS install: what its daemons are started from. */
const OWN_ENTRY = join(import.meta.dir, '..', '..', 'bin', 'jarvis.ts');

function realpathOrNull(path: string): string | null {
  try { return realpathSync(path); } catch { return null; }
}

/**
 * Is this command line (argv of a process) this install's own `jarvis`?
 *
 * Compared by real path, so the symlink a global install puts on PATH counts
 * and a different program that merely mentions "jarvis" does not. This is the
 * proof `jarvis stop` needs before it signals a process it did not find
 * through its own lock.
 */
export function isOwnJarvisCommand(argv: string[], entry: string = OWN_ENTRY, cwd?: string): boolean {
  const own = realpathOrNull(entry);
  if (own === null) return false;
  // A relative path (`bun run bin/jarvis.ts`) means something only from the
  // process's own directory, not ours.
  return argv.some((arg) => arg.includes('/') && realpathOrNull(cwd ? resolve(cwd, arg) : arg) === own);
}

function readProcessCwd(pid: number): string | undefined {
  try { return readlinkSync(`/proc/${pid}/cwd`); } catch { return undefined; }
}

/** argv of a process, or null when it cannot be read (gone, or not ours to read). */
async function readProcessArgv(pid: number): Promise<string[] | null> {
  if (os.platform() === 'linux') {
    try {
      const raw = readFileSync(`/proc/${pid}/cmdline`, 'utf-8');
      const argv = raw.split('\0').filter((a) => a !== '');
      if (argv.length > 0) return argv;
    } catch { /* fall through to ps */ }
  }
  if (os.platform() === 'win32') return null;
  const out = (await captureOutput(['ps', '-o', 'args=', '-p', String(pid)])).trim();
  return out === '' ? null : out.split(/\s+/);
}

/** A listener that is not provably this Jarvis. `name` is the program only, never its arguments. */
export interface ForeignListener { pid: number; name: string }

/**
 * Clear `port` of THIS install's own Jarvis processes, and report everything
 * else that holds it without touching it.
 *
 * Only a process whose command line is this Jarvis is signalled. A port number
 * proves nothing about who is behind it: the founder's other dev server on 3142
 * used to be SIGTERMed and then SIGKILLed by `jarvis stop` (config.example.yaml
 * promises stop never goes after someone else's listener). Those come back in
 * `foreign`, named by program only because arguments can carry secrets.
 * `stuck` is our own listeners that would not die.
 */
export async function ensurePortReleased(
  port: number,
  currentPid: number = process.pid,
  isOurs: (pid: number) => Promise<boolean> = async (pid) => {
    const argv = await readProcessArgv(pid);
    return argv !== null && isOwnJarvisCommand(argv, OWN_ENTRY, readProcessCwd(pid));
  },
): Promise<{ released: boolean; terminated: number[]; forced: number[]; foreign: ForeignListener[]; stuck: number[] }> {
  const initialPids = await findListeningPids(port, currentPid);
  const terminated: number[] = [];
  const forced: number[] = [];
  const foreign: ForeignListener[] = [];

  for (const pid of initialPids) {
    if (!isPidAlive(pid)) continue;

    if (!await isOurs(pid)) {
      const argv = await readProcessArgv(pid);
      foreign.push({ pid, name: argv ? basename(argv[0]!) : 'unknown program' });
      continue;
    }

    try {
      process.kill(pid, 'SIGTERM');
    } catch (err) {
      // EPERM: someone else's listener on our port — we can neither signal it
      // nor wait it out, so skip instead of burning the 2s + 1s waits below.
      // (The old local isPidAlive reported EPERM as dead and skipped at the top
      // of the loop; now that it reports alive, the skip has to be explicit.)
      if ((err as NodeJS.ErrnoException)?.code === 'EPERM') continue;
      // ESRCH and friends: fall through — the wait below returns at once.
    }

    if (await waitForExit(pid, 2000)) {
      terminated.push(pid);
      continue;
    }

    if (!isPidAlive(pid)) {
      terminated.push(pid);
      continue;
    }

    // Two seconds is long enough for the pid to have been freed and handed to
    // someone else: prove it is still ours before the signal that cannot be
    // caught.
    if (!await isOurs(pid)) continue;

    try {
      process.kill(pid, 'SIGKILL');
      if (await waitForExit(pid, 1000)) {
        forced.push(pid);
      }
    } catch {
      // Ignore individual kill failures and verify final port state below.
    }
  }

  const remaining = await findListeningPids(port, currentPid);
  const foreignPids = new Set(foreign.map((f) => f.pid));
  return {
    released: remaining.length === 0,
    terminated,
    forced,
    foreign,
    stuck: remaining.filter((pid) => !foreignPids.has(pid)),
  };
}

/**
 * True when nothing is bound to `port` (checked by binding it the way the
 * daemon will: Bun.serve with no hostname takes 0.0.0.0). A plain
 * `listen({ port })` takes `::` instead, which also collides with a listener on
 * ::1 only and would refuse a port the daemon could have bound.
 */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen({ port, host: '0.0.0.0' }, () => server.close(() => resolve(true)));
  });
}

/**
 * Is `pid` the one answering on `port`? Used by `start -d` so a stranger that
 * already held the port cannot pass for the daemon we just started. When the
 * listener cannot be looked up (no lsof or ss), a connection is all we have.
 */
export async function daemonOwnsPort(pid: number, port: number): Promise<boolean> {
  const accepting = await new Promise<boolean>((resolve) => {
    const socket = Bun.connect({
      hostname: '127.0.0.1',
      port,
      socket: { open(s) { s.end(); resolve(true); }, data() {}, error() { resolve(false); }, connectError() { resolve(false); } },
    });
    socket.catch(() => resolve(false));
  });
  if (!accepting) return false;
  const holders = await findListeningPids(port, process.pid);
  return holders.length === 0 || holders.includes(pid);
}

/**
 * `--port N` or `--port=N` from a command line.
 *
 * Neither "missing" nor "unusable" may fall through to the default: a typo'd
 * `--port=3196` used to be ignored and the daemon came up on 3142 with nothing
 * said. `port` is undefined only when the flag is absent.
 */
export function parsePortArg(args: string[]): { port: number | undefined } | { error: string } {
  const message = '--port requires a number between 1 and 65535';
  let raw: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--port') {
      const next = args[i + 1];
      if (next === undefined || next.startsWith('-')) return { error: message };
      raw = next;
      break;
    }
    if (arg.startsWith('--port=')) {
      raw = arg.slice('--port='.length);
      break;
    }
  }
  if (raw === undefined) return { port: undefined };
  const port = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: message };
  return { port };
}

/**
 * The command line `jarvis start -d` hands its detached child, which re-enters
 * `start` in the foreground. Every option that changes what the daemon does
 * must be forwarded: `--no-local-tools` used to be dropped here, so
 * `start -d --no-local-tools` ran a daemon WITH local tools, and `--data-dir`
 * pointed it at the default data dir.
 */
export function detachedDaemonArgs(entry: string, opts: {
  port?: number;
  dataDir?: string;
  noLocalTools: boolean;
  systemConfigPath?: string;
}): string[] {
  const args = [entry, 'start', '--no-open'];
  if (opts.port) args.push('--port', String(opts.port));
  if (opts.dataDir) args.push('--data-dir', opts.dataDir);
  if (opts.noLocalTools) args.push('--no-local-tools');
  // Without this a hosted `jarvis start -d` would re-enter cmdStart in the
  // child with no flag, and the daemon would (silently) fall back to
  // ~/.jarvis/config.yaml, defeating the whole point of the flag.
  if (opts.systemConfigPath) args.push('--system-config', opts.systemConfigPath);
  return args;
}

/** How the running daemon was started, so `jarvis restart` can start it the same way. */
export interface LaunchRecord {
  pid: number;
  detached: boolean;
  noOpen: boolean;
  noLocalTools: boolean;
  port?: number;
  dataDir?: string;
  systemConfigPath?: string;
}

function launchRecordPath(): string {
  return join(dirname(getPidPath()), 'jarvis.launch.json');
}

export function writeLaunchRecord(record: LaunchRecord): void {
  try { writeFileSync(launchRecordPath(), JSON.stringify(record), { mode: 0o600 }); } catch { /* restart just falls back to plain args */ }
}

export function clearLaunchRecord(): void {
  try { unlinkSync(launchRecordPath()); } catch { /* absent */ }
}

/** The record for the daemon with this pid. A record left by an earlier daemon is ignored. */
export function readLaunchRecord(pid: number): LaunchRecord | null {
  try {
    const raw = JSON.parse(readFileSync(launchRecordPath(), 'utf-8')) as Partial<LaunchRecord> | null;
    if (!raw || raw.pid !== pid) return null;
    const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);
    return {
      pid,
      detached: raw.detached === true,
      noOpen: raw.noOpen === true,
      noLocalTools: raw.noLocalTools === true,
      port: validPort(raw.port) ?? undefined,
      dataDir: str(raw.dataDir),
      systemConfigPath: str(raw.systemConfigPath),
    };
  } catch {
    return null;
  }
}

/**
 * The arguments `jarvis restart` hands to start: what the daemon was started
 * with, except for anything the user passes now.
 */
export function restartStartArgs(record: LaunchRecord | null, userArgs: string[]): string[] {
  const out = [...userArgs];
  if (!record) return out;
  const given = (...flags: string[]) => userArgs.some((a) => flags.some((f) => a === f || a.startsWith(`${f}=`)));
  if (record.detached && !given('-d', '--detach')) out.push('--detach');
  if (record.noOpen && !given('--no-open')) out.push('--no-open');
  if (record.noLocalTools && !given('--no-local-tools')) out.push('--no-local-tools');
  if (record.port !== undefined && !given('--port')) out.push('--port', String(record.port));
  if (record.dataDir !== undefined && !given('--data-dir')) out.push('--data-dir', record.dataDir);
  if (record.systemConfigPath !== undefined && !given('--system-config')) out.push('--system-config', record.systemConfigPath);
  return out;
}

/**
 * The `daemon:` block as the config file states it, read ONCE.
 *
 * One reader for both `daemon.port` and `daemon.listen` because the dangerous
 * answer is the same for both: "this file will not load". Every way of getting
 * that wrong used to end with `resolveStopPort` reporting the 3142 default and
 * `jarvis stop` SIGTERMing whatever unrelated process held it (#550) -- and the
 * file the daemon cannot load is precisely the file where nothing of ours is
 * listening, so the default can only reach someone else.
 *
 * `unusable` is that case. It is not hypothetical: one slipped indent under the
 * very key this is about,
 *
 *     daemon:
 *     port: 8080
 *
 * makes `daemon` null, which `loadConfig` dies on ("null is not an object")
 * while a `parsed?.daemon?.port` lookup quietly reports nothing configured.
 */
type DaemonSection =
  /** No file, no `daemon:` key, or nothing under it that names a setting. */
  | { kind: 'absent' }
  /** `loadConfig` would throw on this file, so the daemon is not running from it. */
  | { kind: 'unusable'; problem: string }
  | { kind: 'section'; port: unknown; listen: unknown };

function readDaemonSection(configPath: string): DaemonSection {
  let parsed: unknown;
  try {
    if (!existsSync(configPath)) return { kind: 'absent' };
    const doc = YAML.parseDocument(readFileSync(configPath, 'utf-8'), { merge: true });
    if (doc.errors.length > 0) return { kind: 'unusable', problem: 'the config file could not be parsed' };
    parsed = doc.toJS();
  } catch (err) {
    // A DIRECTORY where the config file goes is the one read failure loadConfig
    // shrugs off: `Bun.file(dir).exists()` is false, so it takes its "no config
    // file" branch and the daemon boots on the defaults. Absent here too, or the
    // CLI would be stricter than the daemon and skip a port cleanup it owes.
    if ((err as { code?: string } | null)?.code === 'EISDIR') return { kind: 'absent' };
    return { kind: 'unusable', problem: `the config file could not be read (${err instanceof Error ? err.message : String(err)})` };
  }

  // An empty or comment-only file: loadConfig merges nothing and the defaults
  // stand, exactly as with no file at all.
  if (parsed === null || parsed === undefined) return { kind: 'absent' };
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'unusable', problem: 'the config file does not hold a mapping at its top level' };
  }
  if (!('daemon' in parsed)) return { kind: 'absent' };

  const daemon = (parsed as { daemon?: unknown }).daemon;
  // `daemon:` with nothing under it, or a scalar: deepMerge puts that value
  // where the daemon block should be and loadConfig throws on the next line
  // that touches it.
  if (daemon === undefined || daemon === null || typeof daemon !== 'object') {
    return { kind: 'unusable', problem: 'the config file has a `daemon:` key that is not a block of settings' };
  }
  // A LIST under `daemon:` does load -- deepMerge copies it, no setting is
  // found on it, and the daemon binds the default. Both sides then agree on the
  // default, so this is a section with nothing in it, not an unusable file.
  if (Array.isArray(daemon)) return { kind: 'section', port: undefined, listen: undefined };

  const section = daemon as { port?: unknown; listen?: unknown };
  return { kind: 'section', port: section.port, listen: section.listen };
}

/**
 * Why `resolveListen` (src/config/loader.ts) would refuse this `daemon.listen`,
 * or null when it would accept it.
 *
 * Same reasoning as `unusable` above, for the other key in the block: a
 * `listen` the daemon refuses means the daemon is not running, so the config
 * port must not be signalled either. `listen: "tcp:0.0.0.0:80"` used to make
 * `jarvis stop` go after `daemon.port` on a machine where Jarvis never started.
 */
function listenProblem(listen: unknown): string | null {
  if (listen === undefined || listen === null) return null;
  // resolveListen calls .trim() on it, so a non-string takes the daemon down
  // before it binds anything.
  if (typeof listen !== 'string') return 'daemon.listen is not a string, so the daemon cannot resolve it';
  const value = listen.trim();
  // Empty means "no listen spec", which resolveListen reads as plain TCP.
  if (value === '') return null;
  if (value.startsWith('unix:')) {
    // resolveListen demands an absolute path. Reporting this as unix-socket mode
    // would be pid-only either way, so nothing is signalled -- but it would tell
    // the user to look at their proxy for a config the daemon refuses, which is
    // the wrong-advice problem all over again.
    return value.slice('unix:'.length).startsWith('/')
      ? null
      : `daemon.listen is ${JSON.stringify(listen)}, whose unix socket path is not absolute`;
  }
  return `daemon.listen is ${JSON.stringify(listen)}, which the daemon refuses (expected "unix:/abs/path.sock")`;
}

/** The unix socket path in a section, or null when it does not configure one. */
function unixListenOf(section: DaemonSection): string | null {
  if (section.kind !== 'section') return null;
  const listen = section.listen;
  if (typeof listen === 'string' && listen.trim().startsWith('unix:')) return listen.trim().slice('unix:'.length);
  return null;
}

/**
 * What `daemon.port` says in the YAML config: nothing, a port, or something
 * that is not a port.
 *
 * The three cases are kept apart on purpose. Folding "set to something that is
 * not a port" into "not set" is what made `jarvis stop` fall through to the
 * 3142 default and signal whatever unrelated process held that port (#550) --
 * and a quoted `port: "8080"` used to land in that third case, which is why
 * this goes through the same `readPortSetting` the daemon's own load path uses
 * (src/config/port.ts). Quoted and unquoted now resolve identically on both.
 *
 * A file the daemon could not load is `invalid` rather than absent, for the
 * same reason. `problem` is a whole phrase, because it is not always about
 * `daemon.port` itself.
 */
export function readConfiguredPortSetting(configPath = join(homedir(), '.jarvis', 'config.yaml')): PortSetting {
  const section = readDaemonSection(configPath);
  if (section.kind === 'absent') return { kind: 'absent' };
  if (section.kind === 'unusable') return { kind: 'invalid', problem: section.problem };
  const setting = readPortSetting(section.port);
  // readPortSetting's problem is a predicate ("must be ..."); name its subject.
  return setting.kind === 'invalid' ? { kind: 'invalid', problem: `daemon.port ${setting.problem}` } : setting;
}

/**
 * Read `daemon.port` from the YAML config.
 * Returns null when the file is absent, invalid, or the field is missing
 * -- callers decide what default to apply. Callers that would otherwise fall
 * back to a port NOBODY asked for want `readConfiguredPortSetting` instead, so
 * they can tell a broken setting from an absent one.
 */
export function readConfiguredPort(configPath = join(homedir(), '.jarvis', 'config.yaml')): number | null {
  const setting = readConfiguredPortSetting(configPath);
  return setting.kind === 'valid' ? setting.port : null;
}

/**
 * Legacy: the configured port or the hardcoded default, with no way to tell
 * those apart.
 *
 * Do NOT use this for anything that signals a process. "The config said
 * something I could not read, so assume 3142" is the shape of #550, and this
 * is the last function that still has it; it has no callers outside tests.
 * `readConfiguredPortSetting` (or `resolveStopPort`) is what new code wants.
 */
export function getConfiguredPort(configPath?: string): number {
  return readConfiguredPort(configPath) ?? DEFAULT_DAEMON_PORT;
}

/**
 * Where the dashboard of the daemon we are ABOUT to start will be, or no URL
 * at all when it will not listen on TCP.
 *
 * `null` is not "use the default": in unix-socket mode there is no localhost
 * port, and printing or opening `http://localhost:3142` would send the user
 * (or a browser, on every service start) to whatever else happens to be
 * listening there.
 */
export type DashboardTarget =
  | { url: string; port: number; source: 'cli' | 'env' | 'config' | 'default' }
  | { url: null; port: null; source: 'unix-socket' }
  /**
   * The daemon about to start will refuse this config: `daemon.port` is not a
   * port, `daemon.listen` is not a spec it accepts, or the file will not load
   * at all. There is no URL to print and nothing to open -- falling back to
   * 3142 would send the browser to whatever else is listening there (#550).
   * `problem` is a whole phrase naming what is wrong.
   */
  | { url: null; port: null; source: 'invalid-config'; problem: string };

/**
 * Resolve the dashboard URL for `jarvis start`, in the SAME precedence
 * startDaemon uses to pick the port it binds (src/daemon/index.ts):
 *
 *   1. `--port N` on this command line.
 *   2. `JARVIS_PORT`, which the config loader applies over daemon.port.
 *   3. `daemon.port` from ~/.jarvis/config.yaml.
 *   4. The built-in default.
 *
 * ...and `daemon.listen: unix:/path` ahead of all of them, because resolveListen
 * ignores the port entirely when a socket is configured.
 *
 * One caveat on "the same precedence": an explicit --port or JARVIS_PORT is
 * still honoured here over a daemon.port that is merely unreadable, but the
 * loader rejects a broken daemon.port BEFORE it applies JARVIS_PORT, so the
 * daemon refuses to boot either way. `jarvis start` never prints the label
 * before the daemon holds the lock, but `jarvis doctor` and `jarvis onboard`
 * can, so they check the returned `reason` rather than just the URL.
 *
 * Note this is NOT resolveStopPort's order: that one starts from the lockfile,
 * which records the port a RUNNING daemon bound. Nothing has bound anything
 * yet here, and a stale lockfile must not decide where we send a browser.
 */
export function resolveDashboardTarget(options?: {
  cliPort?: unknown;
  configPath?: string;
  env?: Record<string, string | undefined>;
}): DashboardTarget {
  const section = readDaemonSection(options?.configPath ?? join(homedir(), '.jarvis', 'config.yaml'));

  // A file the daemon cannot load has no dashboard, whatever the port sources
  // say: the daemon about to start will exit instead of binding.
  if (section.kind === 'unusable') return { port: null, url: null, source: 'invalid-config', problem: section.problem };
  const badListen = listenProblem(section.kind === 'section' ? section.listen : undefined);
  if (badListen !== null) return { port: null, url: null, source: 'invalid-config', problem: badListen };

  if (unixListenOf(section) !== null) {
    return { url: null, port: null, source: 'unix-socket' };
  }

  // Ahead of --port and JARVIS_PORT, unlike resolveStopPort. This describes the
  // daemon we are ABOUT to start, and normalizeDaemonPort rejects a broken
  // daemon.port before startDaemon ever applies either override -- so there is
  // no dashboard at any port, and neither flag changes that.
  const setting = readPortSetting(section.kind === 'section' ? section.port : undefined);
  if (setting.kind === 'invalid') return { port: null, url: null, source: 'invalid-config', problem: `daemon.port ${setting.problem}` };

  // Each source read once, in order, so the two halves of a branch cannot drift
  // apart and the config file is not parsed twice.
  const env = options?.env ?? process.env;
  const fromCli = validPort(options?.cliPort);
  if (fromCli !== null) return { port: fromCli, source: 'cli', url: `http://localhost:${fromCli}` };

  const fromEnv = validPort(env.JARVIS_PORT);
  if (fromEnv !== null) return { port: fromEnv, source: 'env', url: `http://localhost:${fromEnv}` };

  if (setting.kind === 'valid') return { port: setting.port, source: 'config', url: `http://localhost:${setting.port}` };

  return { port: DEFAULT_DAEMON_PORT, source: 'default', url: `http://localhost:${DEFAULT_DAEMON_PORT}` };
}

/**
 * What to print for the dashboard, and what to open -- null when there is
 * nothing to open.
 *
 * Here rather than in bin/jarvis.ts so the decision is testable in one place:
 * the bug in #544 was in the CLI's wiring, not in the port lookup.
 */
export function describeDashboard(
  target: { url: string | null; source?: DashboardTarget['source'] | StopPortSource; problem?: string },
): { label: string; openUrl: string | null; reason: 'url' | 'unix-socket' | 'invalid-config'; problem: string | null } {
  if (target.url !== null) return { label: target.url, openUrl: target.url, reason: 'url', problem: null };
  // Two different reasons for having no URL, and saying the wrong one sends the
  // user looking in the wrong place -- at a proxy they do not have, rather than
  // at the config key they mistyped. `reason` and `problem` are returned so a
  // caller writing its own follow-up advice needs only this one object;
  // branching on `openUrl` alone is what got that wrong. `source` is optional so
  // a caller holding only a URL still gets the unix-socket wording it always had.
  if (target.source === 'invalid-config') {
    const problem = target.problem ?? 'the config file cannot be loaded';
    return { label: `unknown: ${problem}`, openUrl: null, reason: 'invalid-config', problem };
  }
  return { label: 'on the unix socket in daemon.listen (no localhost port)', openUrl: null, reason: 'unix-socket', problem: null };
}

function validPort(value: unknown): number | null {
  const n = typeof value === 'string' ? Number.parseInt(value, 10) : typeof value === 'number' ? value : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

export type StopPortSource = 'lockfile' | 'env' | 'cli' | 'config' | 'default';

export type StopPortResolution =
  | { port: number; source: StopPortSource }
  /**
   * The config binds a unix socket (`daemon.listen: unix:...`) and no TCP
   * port was recorded in the lockfile: there is NO port to verify or clear.
   * `jarvis stop` must be pid-only - SIGTERM/SIGKILLing whatever same-user
   * process happens to listen on daemon.port/3142 would murder an unrelated
   * service on a hosted box.
   */
  | { port: null; source: 'unix-socket' }
  /**
   * The config the daemon would boot from is one it refuses: a `daemon.port`
   * that is not a port, a `daemon.listen` it will not resolve, or a file that
   * will not load. Also pid-only, because nothing of ours is listening on any
   * port and the 3142 default can only reach someone else's process (#550).
   * `problem` is a whole phrase naming what is wrong.
   */
  | { port: null; source: 'invalid-config'; problem: string };

/**
 * Resolve which port `jarvis stop` should verify.
 *
 * Precedence (highest first):
 *   1. The port the running daemon recorded in its lockfile (authoritative).
 *   2. `JARVIS_PORT` env var (matches `applyEnvOverrides` in the config loader).
 *   3. An explicit `--port N` passed on the stop command line.
 *   4. `daemon.port` from `~/.jarvis/config.yaml`.
 *   5. The hardcoded default (3142).
 *
 * The lockfile wins over everything because it reflects the port the daemon
 * actually bound to, not what config/env said at some point in the past. The
 * env var beats `--port` so a user with a persistent `JARVIS_PORT` in their
 * shell doesn't get caught out by forgetting to pass the flag.
 */
export function resolveStopPort(options?: {
  cliPort?: unknown;
  configPath?: string;
  env?: Record<string, string | undefined>;
}): StopPortResolution {
  const env = options?.env ?? process.env;

  const locked = validPort(readLockedPort());
  if (locked !== null) return { port: locked, source: 'lockfile' };

  // The file, read once for both keys below.
  const section = readDaemonSection(options?.configPath ?? join(homedir(), '.jarvis', 'config.yaml'));

  // Ahead of env and --port, like unix-socket mode below and for the same
  // reason: a file we cannot read might well be configuring a unix socket, so
  // we do not know that ANY port belongs to us. An explicit port is honoured
  // only once we can see that the daemon was on TCP at all.
  if (section.kind === 'unusable') return { port: null, source: 'invalid-config', problem: section.problem };
  const badListen = listenProblem(section.kind === 'section' ? section.listen : undefined);
  if (badListen !== null) return { port: null, source: 'invalid-config', problem: badListen };

  // Unix-socket mode records no port (there is none). Every other source
  // (env/cli/config/default) describes a TCP port the daemon never bound,
  // so port cleanup must be skipped entirely.
  if (unixListenOf(section) !== null) {
    return { port: null, source: 'unix-socket' };
  }

  // Quoted or not, this is the port the daemon binds -- the same reader the
  // config loader uses.
  const setting = readPortSetting(section.kind === 'section' ? section.port : undefined);

  if (setting.kind === 'invalid') {
    // `--port N`, typed on THIS command line, still wins: it is a present-tense
    // claim about a daemon that is already running, from someone standing in
    // front of it.
    //
    // `JARVIS_PORT` does NOT, and that is the difference. The loader rejects a
    // broken `daemon.port` BEFORE it applies `JARVIS_PORT`, so a daemon started
    // from this file is not on the env var's port either -- it is not running at
    // all. Honouring a stale shell export here would run ensurePortReleased
    // against a port nothing of ours ever bound, which is #550's harm by
    // another route. A daemon that really was started on JARVIS_PORT before the
    // file was mistyped is already covered: it holds the lockfile, which is read
    // first.
    const fromCli = validPort(options?.cliPort);
    if (fromCli !== null) return { port: fromCli, source: 'cli' };
    return { port: null, source: 'invalid-config', problem: `daemon.port ${setting.problem}` };
  }

  const fromEnv = validPort(env.JARVIS_PORT);
  if (fromEnv !== null) return { port: fromEnv, source: 'env' };

  const fromCli = validPort(options?.cliPort);
  if (fromCli !== null) return { port: fromCli, source: 'cli' };

  if (setting.kind === 'valid') return { port: setting.port, source: 'config' };

  return { port: DEFAULT_DAEMON_PORT, source: 'default' };
}

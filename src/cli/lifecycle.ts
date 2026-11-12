import { existsSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import os from 'node:os';
import { basename, dirname, join } from 'node:path';
import YAML from 'yaml';
import { getPidPath, readLockedPort, isProcessAlive } from '../daemon/pid.ts';
import { readPortSetting, type PortSetting } from '../config/port.ts';
import { win32SystemExe } from '../util/system-exe.ts';

export const DEFAULT_DAEMON_PORT = 3142;

/**
 * One pid per line, and ONLY lines that are a pid. Taking every run of digits
 * anywhere in the output (as this once did) read a login profile's greeting
 * ("Agent pid 4321", "1 new message") as listeners on the port.
 */
export function parsePidList(output: string, currentPid: number): number[] {
  return [...new Set(
    output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^\d+$/.test(line))
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

/** captureOutput, but '' when the program is not there at all (Bun.spawn throws ENOENT). */
async function captureIfPresent(command: string[]): Promise<string> {
  try {
    return await captureOutput(command);
  } catch {
    return '';
  }
}

/**
 * A system tool by absolute path where it is installed in the usual places
 * (lsof is in /usr/sbin on macOS and some Linux distributions, /usr/bin on
 * others; ss likewise; ps in /bin), else by name.
 */
function systemTool(name: 'lsof' | 'ss' | 'ps'): string {
  for (const dir of ['/usr/sbin', '/usr/bin', '/sbin', '/bin']) {
    if (existsSync(`${dir}/${name}`)) return `${dir}/${name}`;
  }
  return name;
}

/**
 * The PowerShell that lists the pids listening on `port`, one per line.
 * PowerShell's own output already puts each on its own line. This used to
 * `-join "\n"`, but PowerShell escapes with a backtick, so that joined with a
 * literal backslash-n: a process on both 0.0.0.0 and :: came back as
 * `1234\n1234` on one line, which is no pid at all.
 */
export function windowsListenerScript(port: number): string {
  return `Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess`;
}

async function findListeningPids(port: number, currentPid: number): Promise<number[]> {
  if (os.platform() === 'win32') {
    const output = await captureOutput([
      win32SystemExe('powershell.exe'),
      '-NoProfile',
      '-Command',
      windowsListenerScript(port),
    ]);
    return parsePidList(output, currentPid);
  }

  // Run directly, not through `bash -lc`: a login shell sources the user's
  // profile, and whatever that prints lands in the output parsed below.
  const lsofOutput = await captureIfPresent([systemTool('lsof'), '-t', '-n', '-P', `-iTCP:${port}`, '-sTCP:LISTEN']);
  const lsofPids = parsePidList(lsofOutput, currentPid);
  if (lsofPids.length > 0) return lsofPids;

  const ssOutput = await captureIfPresent([systemTool('ss'), '-ltnp', `sport = :${port}`]);
  return [...new Set(
    Array.from(ssOutput.matchAll(/pid=(\d+)/g))
      .map((match) => Number.parseInt(match[1]!, 10))
      .filter((value) => Number.isInteger(value) && value > 0 && value !== currentPid)
  )];
}

/**
 * A process still listening on the port that `jarvis stop` did not kill, what
 * it is called, and why it was left:
 *  - `not-jarvis`: not identified as the Jarvis daemon for this data folder,
 *    so never signalled;
 *  - `no-permission`: identified, but the signal was refused (EPERM);
 *  - `let-go-of-lock`: SIGTERMed as ours, then still running without the lock
 *    when SIGKILL was due, so not killed.
 */
export type PortListener = { pid: number; command: string | null; reason: 'not-jarvis' | 'no-permission' | 'let-go-of-lock' };

export type PortCleanup = {
  /** Nothing listens on the port any more. */
  released: boolean;
  /** Jarvis daemons that exited after SIGTERM. */
  terminated: number[];
  /** Jarvis daemons that needed SIGKILL. */
  forced: number[];
  /**
   * Listeners still on the port that were not stopped, each with the reason
   * (see PortListener). Whoever prints the result names them.
   */
  leftAlone: PortListener[];
};

/**
 * The spellings under which an open handle on `lockPath` can appear in
 * /proc/<pid>/fd or in lsof once the file is gone: as given, and with its
 * folder's symlinks resolved (a ~/.jarvis that is a symlink, macOS's
 * /var -> /private/var). The kernel reports the resolved one.
 */
function lockPathSpellings(lockPath: string): Set<string> {
  const spellings = new Set([lockPath]);
  const anchor = nearestExistingFolder(dirname(lockPath));
  if (anchor !== null) {
    try {
      spellings.add(join(realpathSync(anchor.path), anchor.rest, basename(lockPath)));
    } catch { /* gone while we looked; the path as given is all there is */ }
  }
  return spellings;
}

/**
 * The closest folder at or above `dir` that still exists, and the part of
 * `dir` below it ('' when `dir` itself exists). The whole data folder can be
 * deleted under a running daemon (`rm -rf ~/.jarvis` to start over), and the
 * kernel still names the lock inside it; the folder above it is then what the
 * deleted file is compared with.
 */
function nearestExistingFolder(dir: string): { path: string; rest: string; dev: number } | null {
  let path = dir;
  const below: string[] = [];
  for (;;) {
    try {
      return { path, rest: below.length > 0 ? join(...below) : '', dev: statSync(path).dev };
    } catch { /* missing: try the folder above */ }
    const parent = dirname(path);
    if (parent === path) return null;
    below.unshift(basename(path));
    path = parent;
  }
}

/** Linux appends this to the link of an open file that has since been unlinked. */
const DELETED_SUFFIX = ' (deleted)';

type FileId = { dev: number; ino: number; nlink: number };

function fileId(path: string): FileId | null {
  try {
    const st = statSync(path);
    return { dev: st.dev, ino: st.ino, nlink: st.nlink };
  } catch {
    return null;
  }
}

/**
 * A deleted file's link names a path inside the process's own mount
 * namespace, so the same path means the same folder only when that is ours.
 */
function sameMountNamespace(pid: number): boolean {
  try {
    return readlinkSync(`/proc/${pid}/ns/mnt`) === readlinkSync('/proc/self/ns/mnt');
  } catch {
    return false;
  }
}

/**
 * Is `pid` the Jarvis daemon for the data folder whose lock file is `lockPath`?
 *
 * The test is whether the process holds that lock file open. The daemon opens
 * it in acquireLock and keeps the descriptor for its whole life (that open
 * descriptor IS the flock), and nothing else does. The descriptor is not
 * close-on-exec, but Bun.spawn and node:child_process close every descriptor
 * beyond stdio in the child (measured on both), so the daemon's own children
 * do not inherit it.
 *
 * A pid number, a name or a command line proves much less -- pids are
 * reused, and any program can be called `bun`.
 *
 * "That lock file" means the same file, not the same path: an open file is
 * compared by device and inode with the one at `lockPath`, so a daemon in a
 * container whose lock happens to sit at the same path (a different file, in
 * another mount namespace) is not ours. The one case compared by path is a lock
 * file unlinked under a running daemon, which is the main way a live daemon
 * ends up holding no lock that `jarvis stop` can see. There is no file left to
 * compare with, so on Linux the open file must have no links left, its
 * "<path> (deleted)" link must name our path, it must live on the same device
 * as our data folder (or, when that folder was deleted too, the closest folder
 * above it), and the process must see the same mount namespace. macOS's lsof may
 * not name a deleted file at all; then the daemon is not identified, which is
 * the safe way to be wrong.
 *
 * Anything we cannot inspect is NOT ours: another user's process (its
 * /proc/<pid>/fd is unreadable, and we could not signal it anyway), a platform
 * without /proc or lsof, and native Windows, where the daemon does not run at
 * all (pid.ts refuses to take the lock there).
 */
export async function holdsJarvisLock(pid: number, lockPath: string = getPidPath()): Promise<boolean> {
  const platform = os.platform();
  if (platform === 'win32') return false;
  const lock = fileId(lockPath);
  // The data folder, or the closest folder above it when the whole folder was
  // deleted under the daemon.
  const folder = nearestExistingFolder(dirname(lockPath));
  const spellings = lockPathSpellings(lockPath);
  const isDeletedLock = (name: string) =>
    name.endsWith(DELETED_SUFFIX) && spellings.has(name.slice(0, -DELETED_SUFFIX.length));

  if (platform === 'linux') {
    const fdDir = `/proc/${pid}/fd`;
    let fds: string[];
    try {
      fds = readdirSync(fdDir);
    } catch {
      return false;
    }
    for (const fd of fds) {
      try {
        const link = readlinkSync(join(fdDir, fd));
        // stat() through the magic link reaches the open file itself, wherever
        // (and in whichever mount namespace) it lives.
        const open = fileId(join(fdDir, fd));
        if (open === null) continue;
        if (lock !== null && open.dev === lock.dev && open.ino === lock.ino) return true;
        // nlink 0 is what makes it deleted. A file literally NAMED
        // "jarvis.pid (deleted)" has a link and does not pass. (The device
        // check has no test: it needs a second filesystem at the same path.)
        if (folder !== null && open.dev === folder.dev && open.nlink === 0 && isDeletedLock(link) && sameMountNamespace(pid)) return true;
      } catch { /* closed while we looked */ }
    }
    return false;
  }

  // macOS and the BSDs: no /proc, so ask lsof for the process's open files.
  // `-F Din` prints, per file, its device (hex), inode and name on lines
  // starting D, i and n; -w silences warnings about filesystems it cannot
  // stat, which would otherwise go to stderr.
  try {
    const output = await captureOutput([systemTool('lsof'), '-n', '-P', '-w', '-p', String(pid), '-F', 'Din']);
    let dev: number | null = null;
    let ino: number | null = null;
    for (const line of output.split(/\r?\n/)) {
      const field = line[0];
      const value = line.slice(1);
      if (field === 'f') { dev = null; ino = null; }
      else if (field === 'D') dev = Number.parseInt(value, 16);
      else if (field === 'i') ino = Number(value);
      else if (field === 'n') {
        if (lock !== null && ino === lock.ino && dev === lock.dev) return true;
        // No inode to compare once the file is gone: the name alone, as above.
        if (lock === null && spellings.has(value)) return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * The process's short name, for telling the user who holds the port; null when
 * unknown. Control characters become `?`: a process sets its own name, and one
 * carrying escape sequences must not get to drive the user's terminal.
 */
async function processName(pid: number): Promise<string | null> {
  const name = await rawProcessName(pid);
  return name === null ? null : printableName(name);
}

/** `name` with every control character (C0, DEL, C1) replaced by `?`. */
export function printableName(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?');
}

async function rawProcessName(pid: number): Promise<string | null> {
  try {
    if (os.platform() === 'linux') {
      return readFileSync(`/proc/${pid}/comm`, 'utf-8').trim() || null;
    }
    if (os.platform() === 'win32') {
      const output = await captureOutput([
        win32SystemExe('powershell.exe'),
        '-NoProfile',
        '-Command',
        `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).ProcessName`,
      ]);
      return output.trim() || null;
    }
    const output = await captureOutput([systemTool('ps'), '-o', 'comm=', '-p', String(pid)]);
    return output.trim() || null;
  } catch {
    return null;
  }
}

/** The command that shows who listens on `port`, for the user to run. */
export function portInspectCommand(port: number, platform: NodeJS.Platform = os.platform()): string {
  if (platform === 'win32') return `netstat -ano | findstr :${port}`;
  if (platform === 'linux') return `lsof -nP -iTCP:${port} -sTCP:LISTEN  (or: ss -ltnp 'sport = :${port}'; add sudo to see other users' programs)`;
  return `lsof -nP -iTCP:${port} -sTCP:LISTEN`;
}

/**
 * What to tell the user about listeners `jarvis stop` left alone: who they are,
 * and how to look for themselves. Empty when there are none.
 */
export function describeLeftAlone(port: number, leftAlone: PortListener[], platform: NodeJS.Platform = os.platform()): string[] {
  if (leftAlone.length === 0) return [];
  const who = (reason: PortListener['reason']) => leftAlone
    .filter((l) => l.reason === reason)
    .map(({ pid, command }) => (command ? `PID ${pid} (${command})` : `PID ${pid}`))
    .join(', ');
  const lines: string[] = [];
  const notJarvis = who('not-jarvis');
  if (notJarvis) lines.push(`Port ${port} is held by ${notJarvis}, which is not the Jarvis daemon for this data folder, so it was left running.`);
  const noPermission = who('no-permission');
  if (noPermission) lines.push(`Port ${port} is held by ${noPermission}, a Jarvis daemon for this data folder that this user may not signal. Stop it as its owner, or with root.`);
  const letGo = who('let-go-of-lock');
  if (letGo) lines.push(`Port ${port} is still held by ${letGo}, which was asked to stop but no longer holds this data folder's lock, so it was not force-killed.`);
  lines.push(`See what it is: ${portInspectCommand(port, platform)}`);
  return lines;
}

/**
 * Clear `port` of a lingering Jarvis daemon: SIGTERM, then SIGKILL if it has
 * not gone within two seconds.
 *
 * Only a listener that holds this data folder's lock file open is signalled
 * (see holdsJarvisLock). Everything else is reported in `leftAlone` and never
 * touched. This used to signal every listener on the port, and with no daemon
 * running `jarvis stop` resolves the port from config or the 3142 default, so
 * a plain `jarvis stop` killed whatever unrelated program was on 3142.
 */
export async function ensurePortReleased(
  port: number,
  options: { currentPid?: number; lockPath?: string } = {},
): Promise<PortCleanup> {
  const currentPid = options.currentPid ?? process.pid;
  const lockPath = options.lockPath ?? getPidPath();
  const initialPids = await findListeningPids(port, currentPid);
  if (initialPids.length === 0) {
    return { released: true, terminated: [], forced: [], leftAlone: [] };
  }

  const terminated: number[] = [];
  const forced: number[] = [];
  const leftAlone: PortListener[] = [];
  const leaveAlone = async (pid: number, reason: PortListener['reason']) => {
    leftAlone.push({ pid, command: await processName(pid), reason });
  };

  for (const pid of initialPids) {
    if (!isPidAlive(pid)) continue;
    if (!(await holdsJarvisLock(pid, lockPath))) {
      await leaveAlone(pid, 'not-jarvis');
      continue;
    }

    try {
      process.kill(pid, 'SIGTERM');
    } catch (err) {
      // EPERM: we can neither signal it nor wait it out, so skip instead of
      // burning the 2s + 1s waits below. (Rare once the lock check passed: it
      // takes a process we could inspect but not signal.)
      if ((err as NodeJS.ErrnoException)?.code === 'EPERM') {
        await leaveAlone(pid, 'no-permission');
        continue;
      }
      // ESRCH and friends: fall through -- the wait below returns at once.
    }

    if (await waitForExit(pid, 2000)) {
      terminated.push(pid);
      continue;
    }

    // Ask again before SIGKILL. A process that no longer holds the lock is not
    // something we may kill: normally it is our daemon in its last instant
    // (it closes the lock as it exits) or a zombie waiting to be reaped, and in
    // theory a reused pid. Give it a moment instead of a SIGKILL.
    if (!(await holdsJarvisLock(pid, lockPath))) {
      if (await waitForExit(pid, 1000)) terminated.push(pid);
      else await leaveAlone(pid, 'let-go-of-lock');
      continue;
    }

    try {
      process.kill(pid, 'SIGKILL');
      if (await waitForExit(pid, 1000)) {
        forced.push(pid);
      }
    } catch {
      // Ignore individual kill failures and verify final port state below.
    }
  }

  // Name only the ones still on the port. One that was asked to stop and has
  // since let go of it (or exited and is a zombie nobody has reaped yet) holds
  // nothing, and "Port N is still held by" would be wrong.
  const remaining = await findListeningPids(port, currentPid);
  return {
    released: remaining.length === 0,
    terminated,
    forced,
    leftAlone: leftAlone.filter((listener) => remaining.includes(listener.pid)),
  };
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

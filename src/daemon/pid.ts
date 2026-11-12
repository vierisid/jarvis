/**
 * Process Lock Manager for J.A.R.V.I.S. Daemon
 *
 * Uses flock()-based advisory locks to prevent duplicate daemon instances.
 * Unlike PID-based checks, flock locks are automatically released by the OS
 * when the process dies (even on SIGKILL, OOM, or crash), making this
 * container-safe and race-free.
 */

import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import {
  constants,
  existsSync,
  readFileSync,
  unlinkSync,
  mkdirSync,
  openSync,
  closeSync,
  writeSync,
  ftruncateSync,
  fchmodSync,
  fstatSync,
  statSync,
} from 'node:fs';
import { cc } from 'bun:ffi';
import flockSource from './flock.c' with { type: 'file' };

const JARVIS_DIR = join(homedir(), '.jarvis');

/**
 * The daemon's own root: `JARVIS_HOME` when set (hosted wrappers export it for
 * every jarvis invocation on an instance), `~/.jarvis` otherwise. The lock
 * lives HERE — in the same root the daemon serves — so tools that probe "is a
 * daemon running against this data dir" (restore, the rotation script) and the
 * daemon itself can never disagree about which file to flock. Computed per
 * call, not at module load, because config loading honors the same env var.
 */
function daemonRootDir(): string {
  return process.env.JARVIS_HOME || JARVIS_DIR;
}

function defaultLockPath(): string {
  return join(daemonRootDir(), 'jarvis.pid');
}

/**
 * Resolve the lock-file path for a given data dir. With no argument this is
 * the daemon's own lock path (JARVIS_HOME-aware, see `daemonRootDir`); the
 * encryption rotation script passes an explicit `--data-dir` to probe the lock
 * for that specific dir. Keep the file name in lock-step with
 * `defaultLockPath` above.
 */
export function lockPathFor(dataDir?: string): string {
  if (!dataDir) return defaultLockPath();
  return join(dataDir, 'jarvis.pid');
}

// ── flock() via Bun cc() ────────────────────────────────────────────
// Compiled lazily on first use by Bun's embedded TinyCC. Resolves libc
// via system headers — works on Linux, macOS, and any POSIX platform
// without hardcoding a shared library path.
//
// Compilation is deferred (not run at module load) so that importing
// this module's pure-fs helpers stays safe on platforms where the helper
// can't be built. On native Windows the daemon is unsupported, and the C
// source depends on POSIX headers that don't exist there — guarding here
// surfaces a clear message instead of a low-level TinyCC header error.

type FlockSymbols = {
  do_flock: (fd: number, operation: number) => number;
  do_cloexec: (fd: number) => number;
};

let flockSymbols: FlockSymbols | null = null;

function getFlock(): FlockSymbols {
  if (process.platform === 'win32') {
    throw new Error(
      'The JARVIS daemon is not compatible with native Windows. Use WSL2 or Docker.',
    );
  }
  if (flockSymbols === null) {
    const { symbols } = cc({
      source: flockSource,
      symbols: {
        do_flock: { args: ['i32', 'i32'], returns: 'i32' },
        do_cloexec: { args: ['i32'], returns: 'i32' },
      },
    });
    flockSymbols = symbols as FlockSymbols;
  }
  return flockSymbols;
}

const LOCK_EX = 2;  // Exclusive lock
const LOCK_NB = 4;  // Non-blocking
const LOCK_SH = 1;  // Shared lock
const LOCK_UN = 8;  // Unlock

// ── Lock state ───────────────────────────────────────────────────────

// The open FD that holds the flock — kept alive for the process lifetime.
// When the process exits (normally, SIGKILL, OOM, crash), the OS closes it
// and the advisory lock is automatically released.
let lockFd: number | null = null;

// ── Public API ───────────────────────────────────────────────────────

/**
 * Acquire an exclusive lock on the lock file and write the PID.
 * Returns true if the lock was acquired, false if another instance holds it.
 */
export function acquireLock(pid: number): boolean {
  try {
    // Resolve the flock helper first so an unsupported platform fails before
    // we create the data dir or open an fd (nothing to leak / clean up).
    const flock = getFlock();

    // 0700/0600: the data folder and its lock are this user's alone. The modes
    // apply only to what this creates; an existing folder keeps its own.
    makeOwnerFolder(daemonRootDir());

    // Open (or create) the lock file — don't truncate before locking
    const fd = openLockFile(defaultLockPath(), flock);

    // Try non-blocking exclusive lock
    const result = flock.do_flock(fd, LOCK_EX | LOCK_NB);
    if (result !== 0) {
      closeSync(fd);
      return false;
    }

    // A lock file from an older version may still be 0644.
    narrowToOwner(fd);

    // Lock acquired — truncate and write PID for display purposes
    ftruncateSync(fd, 0);
    writeSync(fd, String(pid));

    // Keep the FD open — closing it would release the lock
    lockFd = fd;
    return true;
  } catch (err) {
    console.error(`[PID] Failed to acquire lock: ${err}`);
    return false;
  }
}

/**
 * Check if the daemon lock is currently held.
 * Returns the PID if locked (daemon running), null otherwise.
 *
 * Accepts an optional explicit `lockPath` to probe a non-default location
 * (used by the encryption rotation script when given `--data-dir`). The
 * default probes the daemon's own lock path (JARVIS_HOME-aware).
 */
export function isLocked(lockPath: string = defaultLockPath()): number | null {
  if (!existsSync(lockPath)) return null;

  let fd: number;
  try {
    fd = openSync(lockPath, constants.O_RDONLY);
  } catch {
    return null;
  }

  try {
    // Try non-blocking exclusive lock to probe
    const result = getFlock().do_flock(fd, LOCK_EX | LOCK_NB);
    if (result === 0) {
      // Lock acquired — no daemon running. Release immediately.
      getFlock().do_flock(fd, LOCK_UN);
      closeSync(fd);
      return null;
    }
    // Lock held by another process: a daemon is running. A held flock is
    // never stale, whatever pid the file names: the kernel drops the lock when
    // its holder dies, so a lock left by an earlier container (or a crash) is
    // one the probe above takes, and lands in the branch before this. In
    // particular a pid of 1 inside a container is the live daemon itself, the
    // container's init. This used to treat that as stale and unlink the lock,
    // so `docker exec <c> jarvis status` reported the running daemon as
    // stopped, deleted its lock, and let a second daemon start on the same
    // data folder.
    closeSync(fd);
    return readPidAt(lockPath);
  } catch {
    try { closeSync(fd); } catch { /* already closed */ }
    return null;
  }
}

/**
 * Acquire an exclusive lock at an arbitrary `lockPath`. Returns a handle that
 * releases the lock + unlinks the file. Distinct from `acquireLock`, which
 * always targets the daemon's own lock path and is only used by the
 * daemon itself. This helper exists for tests and tools (e.g. the rotation
 * script's test fixture) that need to simulate "a daemon is running against
 * this data dir" without colliding with a real daemon on the dev machine.
 *
 * Returns null if the lock is already held.
 */
export function acquireLockAt(lockPath: string, pid: number): { release: () => void } | null {
  try {
    const flock = getFlock();
    makeOwnerFolder(dirname(lockPath));
    const fd = openLockFile(lockPath, flock);
    const result = flock.do_flock(fd, LOCK_EX | LOCK_NB);
    if (result !== 0) {
      closeSync(fd);
      return null;
    }
    narrowToOwner(fd);
    ftruncateSync(fd, 0);
    writeSync(fd, String(pid));
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        try { closeSync(fd); } catch { /* already closed */ }
        try { if (existsSync(lockPath)) unlinkSync(lockPath); } catch { /* ignore */ }
      },
    };
  } catch {
    return null;
  }
}

/**
 * Open (or create) the lock file for writing, refusing anything that is not
 * this user's own plain file: the path is written to (truncated, then the pid),
 * so a symlink or a hard link planted there would redirect that write to
 * another file. O_NOFOLLOW refuses a symlink at the last component, and the
 * fstat checks a hard link (two names) and another user's file. Root may take
 * a lock file its daemon user owns (`docker exec -u 0`).
 *
 * The descriptor is made close-on-exec: a child that inherited it would keep
 * the flock, and the data folder locked, after the daemon died.
 */
function openLockFile(lockPath: string, flock: FlockSymbols): number {
  // O_NONBLOCK: opening a FIFO planted at the path must not hang. It changes
  // nothing for a regular file's reads, writes or flock.
  const fd = openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const st = fstatSync(fd);
    const euid = process.geteuid?.();
    const problem = !st.isFile() ? 'is not a regular file'
      : st.nlink !== 1 ? `has ${st.nlink} names (a hard link)`
      : euid !== undefined && euid !== 0 && st.uid !== euid ? 'belongs to another user'
      : null;
    if (problem) {
      throw new Error(`The lock file ${lockPath} ${problem}, so Jarvis will not write to it. Remove it if nothing uses it, then start again.`);
    }
    const err = flock.do_cloexec(fd);
    if (err !== 0) throw new Error(`could not mark ${lockPath} close-on-exec (errno ${err})`);
  } catch (err) {
    closeSync(fd);
    throw err;
  }
  return fd;
}

/**
 * Make a lock file this process holds readable and writable by its owner only
 * (one from an older version may still be 0644). Best effort, and only for this
 * user's own file: root taking its daemon user's lock leaves the mode alone.
 */
function narrowToOwner(fd: number): void {
  try {
    if (fstatSync(fd).uid !== process.geteuid?.()) return;
    fchmodSync(fd, 0o600);
  } catch { /* not ours to change */ }
}

/**
 * Create `dir` 0700 when missing. Parents it has to create get 0755 (less the
 * umask), not 0700: `mkdir -p` with a mode would make them 0700 too, and a
 * parent may be shared with other users or services.
 */
function makeOwnerFolder(dir: string): void {
  // 0755 rather than the default 0777: under a umask of 0 the default would
  // leave a parent anyone can rename the data folder out of.
  mkdirSync(dirname(dir), { recursive: true, mode: 0o755 });
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err;
  }
}

/**
 * Release the lock (close the FD) and remove the lock file.
 */
export function releaseLock(): void {
  if (lockFd !== null) {
    try {
      closeSync(lockFd);
    } catch {
      // Already closed
    }
    lockFd = null;
  }
  try {
    const lockPath = defaultLockPath();
    if (existsSync(lockPath)) unlinkSync(lockPath);
  } catch { /* ignore */ }
}

/**
 * Remove the lockfile ONLY if no process currently holds the flock.
 * Returns true when the lock is free afterwards (cleared, or never there).
 *
 * Callers that stop the daemon need "is it safe to unlink this file", and
 * neither `isProcessAlive` nor `isLocked` answers that correctly:
 *
 *  - a pid check misses a supervisor relaunch (launchd KeepAlive, systemd
 *    Restart) that put a NEW process behind the same lock;
 *  - `isLocked` returns null for "held but the pid is unreadable" — the lock
 *    file is empty for an instant during acquireLock's truncate→write, and
 *    unreadable entirely if it belongs to another user — which would read as
 *    "free" and unlink a live holder's lock.
 *
 * This asks the only authoritative question (can I take the flock?) and does
 * the unlink WHILE HOLDING it, so no acquirer can slip into the gap between
 * the check and the removal.
 */
export function releaseLockIfUnheld(): boolean {
  // We hold it ourselves — the normal release path already handles that.
  if (lockFd !== null) {
    releaseLock();
    return true;
  }

  const lockPath = defaultLockPath();
  if (!existsSync(lockPath)) return true;

  let fd: number;
  try {
    fd = openSync(lockPath, constants.O_RDONLY);
  } catch {
    // Can't even open it (e.g. EACCES on another user's file) — treat as held,
    // never as free.
    return false;
  }

  try {
    const flock = getFlock();
    if (flock.do_flock(fd, LOCK_EX | LOCK_NB) !== 0) {
      closeSync(fd);
      return false; // someone holds it
    }
    try { unlinkSync(lockPath); } catch { /* already gone */ }
    flock.do_flock(fd, LOCK_UN);
    closeSync(fd);
    return true;
  } catch {
    try { closeSync(fd); } catch { /* already closed */ }
    return false;
  }
}

/**
 * Read the PID from the lock file. Returns null if no file or invalid content.
 *
 * Lock file format (either form is accepted):
 *   PID            (legacy — single line)
 *   PID\nPORT      (current — PID on line 1, bound port on line 2)
 */
export function readPid(): number | null {
  return readPidAt(defaultLockPath());
}

function readPidAt(lockPath: string): number | null {
  if (!existsSync(lockPath)) return null;
  try {
    const content = readFileSync(lockPath, 'utf-8');
    const firstLine = content.split(/\r?\n/, 1)[0]?.trim() ?? '';
    const pid = parseInt(firstLine, 10);
    if (isNaN(pid) || pid <= 0) return null;
    return pid;
  } catch {
    return null;
  }
}

/**
 * Read the port the locked daemon bound to, if it recorded one.
 * Returns null for legacy lock files that contain only a PID.
 */
export function readLockedPort(): number | null {
  const lockPath = defaultLockPath();
  if (!existsSync(lockPath)) return null;
  try {
    const content = readFileSync(lockPath, 'utf-8');
    const lines = content.split(/\r?\n/);
    const raw = lines[1]?.trim();
    if (!raw) return null;
    const port = parseInt(raw, 10);
    if (isNaN(port) || port < 1 || port > 65535) return null;
    return port;
  } catch {
    return null;
  }
}

/**
 * Record the port the daemon has successfully bound to. Called from the
 * daemon itself after port resolution so `jarvis stop` knows exactly which
 * port to verify, regardless of how the daemon was launched (CLI flag, env
 * var, config file, or default).
 *
 * No-op if the lock isn't held by this process.
 *
 * Second reader, outside this file: the Docker image's HEALTHCHECK reads the
 * port off line two to probe `/health` (#614). It tolerates a missing file
 * and falls back to JARVIS_PORT, then 3142, but it does assume the port is
 * the second run of digits. Inserting a line before it would send the probe
 * to the wrong port, so keep the two in step.
 */
export function writeLockedPort(port: number): void {
  if (lockFd === null) return;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    // Loudly, because this silence is half of #550: a quoted `daemon.port`
    // reached here as the STRING "8080", nothing was recorded, and `jarvis
    // stop` then fell back to 3142 and signalled an unrelated listener. The
    // config loader coerces the port now, so reaching this is a bug upstream.
    // String(), not JSON.stringify(): the latter renders NaN and Infinity as
    // "null", which is exactly the wrong word for a value that was passed.
    console.error(`[PID] Refusing to record ${typeof port === 'string' ? JSON.stringify(port) : String(port)} as the daemon's port: not a port number. \`jarvis stop\` will not know which port to verify.`);
    return;
  }
  try {
    const pid = process.pid;
    ftruncateSync(lockFd, 0);
    writeSync(lockFd, `${pid}\n${port}\n`, 0);
  } catch (err) {
    console.error(`[PID] Failed to record port ${port} in lock file: ${err}`);
  }
}

/**
 * Does `pid` hold the flock on the file at `lockPath`? Linux only, from
 * /proc/locks: true or false when that answers it, null when it cannot (no
 * /proc/locks, the lock file is gone, or the table could not be read).
 *
 * /proc/locks is the kernel's own table of who holds which lock. Unlike
 * /proc/<pid>/fd it is readable by every user and not ptrace-gated, so it still
 * answers for the daemon after it hardens itself (PR_SET_DUMPABLE 0, see
 * hardenProcessInspection), which makes its fd folder unreadable to anyone else.
 * Pids are shown in the reader's own pid namespace, so a holder in another
 * container never matches. A line reads, for a flock on device 08:40 inode 641284:
 *
 *   49: FLOCK  ADVISORY  WRITE 11 08:40:641284 0 EOF
 *
 * and a waiter has `->` after the number. Device numbers are hex major:minor;
 * stat's st_dev is decoded the way glibc's major()/minor() do. Measured on
 * ext4, on overlayfs and on a bind-mounted Docker volume: the triple matches
 * stat of the path in every case.
 */
export function flockHeldBy(pid: number, lockPath: string = defaultLockPath()): boolean | null {
  if (process.platform !== 'linux') return null;
  // One open, so the inode and the mount come from the same file. O_NONBLOCK
  // so a FIFO planted at the path cannot hang the probe; O_NOFOLLOW so it
  // names the lock file itself.
  let fd: number | null = null;
  let table: string;
  let ino: bigint;
  let exact: [bigint, bigint];
  let mounted: [bigint, bigint] | null;
  let fileIsLocked = true;
  try {
    fd = openSync(lockPath, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const st = fstatSync(fd, { bigint: true });
    if (!st.isFile()) return null;
    ino = st.ino;
    exact = splitDev(st.dev);
    mounted = mountDeviceOfFd(fd);
    table = readFileSync('/proc/locks', 'utf-8');
    // The mount-device fallback needs proof that THIS file is locked at all: a
    // lone line on that key could be another subvolume's file with the same
    // inode number while ours is a stale, unheld lock. A shared probe that
    // succeeds means nobody holds ours exclusively.
    const flock = getFlock();
    if (flock.do_flock(fd, LOCK_SH | LOCK_NB) === 0) {
      flock.do_flock(fd, LOCK_UN);
      fileIsLocked = false;
    }
  } catch {
    return null;
  } finally {
    if (fd !== null) try { closeSync(fd); } catch { /* already closed */ }
  }
  return lockTableShowsHolder(table, pid, ino, exact, fileIsLocked ? mounted : null);
}

type LockLine = { pid: number; write: boolean; major: bigint; minor: bigint; ino: bigint };

function flockLines(table: string): LockLine[] {
  const lines: LockLine[] = [];
  for (const line of table.split('\n')) {
    const m = /^\d+:\s+(->\s+)?(\S+)\s+(\S+)\s+(\S+)\s+(-?\d+)\s+([0-9a-fA-F]+):([0-9a-fA-F]+):(\d+)\s/.exec(line);
    if (!m || m[1] || m[2] !== 'FLOCK' || m[3] !== 'ADVISORY') continue;
    lines.push({ pid: Number(m[5]), write: m[4] === 'WRITE', major: BigInt(`0x${m[6]}`), minor: BigInt(`0x${m[7]}`), ino: BigInt(m[8]!) });
  }
  return lines;
}

/**
 * Does `table` (/proc/locks) show `pid` holding the write flock on inode `ino`?
 * Waiters (`->`), POSIX, OFD and lease lines never count.
 *
 * The device is matched exactly (stat's) when any flock line names it. Only
 * when none does is the mount's device tried (`mounted`): on btrfs every
 * subvolume has its own st_dev but /proc/locks prints the filesystem's. That
 * key is weaker, since inode numbers repeat across subvolumes, so it counts
 * only when exactly one flock in the whole table is on it, and that one is a
 * write lock held by `pid`. Callers pass `mounted` only once they know the
 * lock file itself is locked (flockHeldBy probes it).
 */
export function lockTableShowsHolder(
  table: string,
  pid: number,
  ino: bigint,
  exact: [bigint, bigint],
  mounted: [bigint, bigint] | null = null,
): boolean {
  const lines = flockLines(table);
  const on = ([major, minor]: [bigint, bigint]) =>
    lines.filter((l) => l.ino === ino && l.major === major && l.minor === minor);
  const exactLines = on(exact);
  if (exactLines.length > 0) return exactLines.some((l) => l.pid === pid && l.write);
  if (mounted === null) return false;
  const mountLines = on(mounted);
  return mountLines.length === 1 && mountLines[0]!.pid === pid && mountLines[0]!.write;
}

/** st_dev as [major, minor], decoded the way glibc's major()/minor() do. */
function splitDev(dev: bigint): [bigint, bigint] {
  return [((dev >> 8n) & 0xfffn) | ((dev >> 32n) & ~0xfffn), (dev & 0xffn) | ((dev >> 12n) & ~0xffn)];
}

/**
 * The device of the mount `path` lives on, from /proc/self/mountinfo: the
 * filesystem's own device, which is what /proc/locks prints. stat() can report
 * another one: each btrfs subvolume gets its own st_dev (measured: a flock in a
 * subvolume showed as 00:ad in /proc/locks, mountinfo 0:173, while stat said
 * device 223). Null when it cannot be told.
 */
export function mountDeviceOf(path: string): [bigint, bigint] | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    return mountDeviceOfFd(fd);
  } catch {
    return null;
  } finally {
    if (fd !== null) try { closeSync(fd); } catch { /* already closed */ }
  }
}

function mountDeviceOfFd(fd: number): [bigint, bigint] | null {
  try {
    const mntId = /^mnt_id:\s+(\d+)/m.exec(readFileSync(`/proc/self/fdinfo/${fd}`, 'utf-8'))?.[1];
    if (!mntId) return null;
    for (const line of readFileSync('/proc/self/mountinfo', 'utf-8').split('\n')) {
      const fields = line.split(' ');
      if (fields[0] !== mntId) continue;
      const dev = /^(\d+):(\d+)$/.exec(fields[2] ?? '');
      return dev ? [BigInt(dev[1]!), BigInt(dev[2]!)] : null;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Get the lock file path (for display purposes).
 */
export function getPidPath(): string {
  return defaultLockPath();
}

/**
 * Get the log file path. Creates the log directory if needed.
 *
 * JARVIS_HOME-aware, like the lock path above. These used to be module-level
 * constants built from homedir() at import time, so on an instance that sets
 * JARVIS_HOME the daemon locked one root and logged to a different one —
 * `jarvis logs` then tailed a file the daemon wasn't writing.
 */
export function getLogPath(): string {
  // The data folder first, so a `jarvis start -d` (which asks for the log path
  // before the daemon takes its lock) creates it 0700 too, not 0755.
  makeOwnerFolder(daemonRootDir());
  const dir = getLogDir();
  mkdirSync(dir, { recursive: true });
  return join(dir, 'jarvis.log');
}

/**
 * Get the log directory path. Resolved per call — see `daemonRootDir`.
 */
export function getLogDir(): string {
  return join(daemonRootDir(), 'logs');
}

/**
 * Is `pid` still running?
 *
 * EPERM means the process EXISTS but isn't ours to signal (a daemon running as
 * another user) — that is ALIVE. Only ESRCH means "no such process". Getting
 * this backwards is dangerous: callers use it to decide whether it's safe to
 * clear the lockfile, and reporting a live daemon as dead lets a second one
 * start against the same data dir.
 *
 * Lives here, next to the lock, because every caller that asks "is the daemon
 * alive" is really asking "is it safe to touch its lock" — and three separate
 * copies of this check had already drifted apart.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/**
 * Poll until `pid` is gone, or the budget runs out. Returns true if it exited.
 *
 * Needed after SIGKILL: the signal returns before the kernel finishes tearing
 * the process down, and a killed-but-unreaped zombie still answers kill(pid, 0).
 */
export async function waitForProcessExit(
  pid: number,
  timeoutMs: number,
  pollIntervalMs = 50,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  return !isProcessAlive(pid);
}

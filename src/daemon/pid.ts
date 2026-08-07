/**
 * Process Lock Manager for J.A.R.V.I.S. Daemon
 *
 * Uses flock()-based advisory locks to prevent duplicate daemon instances.
 * Unlike PID-based checks, flock locks are automatically released by the OS
 * when the process dies (even on SIGKILL, OOM, or crash), making this
 * container-safe and race-free.
 */

import { join } from 'node:path';
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
} from 'node:fs';
import { cc } from 'bun:ffi';
import flockSource from './flock.c' with { type: 'file' };

const JARVIS_DIR = join(homedir(), '.jarvis');
const LOG_DIR = join(JARVIS_DIR, 'logs');
const LOG_PATH = join(LOG_DIR, 'jarvis.log');

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
      },
    });
    flockSymbols = symbols as FlockSymbols;
  }
  return flockSymbols;
}

const LOCK_EX = 2;  // Exclusive lock
const LOCK_NB = 4;  // Non-blocking
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

    mkdirSync(daemonRootDir(), { recursive: true });

    // Open (or create) the lock file — don't truncate before locking
    const fd = openSync(defaultLockPath(), constants.O_WRONLY | constants.O_CREAT, 0o644);

    // Try non-blocking exclusive lock
    const result = flock.do_flock(fd, LOCK_EX | LOCK_NB);
    if (result !== 0) {
      closeSync(fd);
      return false;
    }

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
    // Lock held by another process — daemon is running
    closeSync(fd);
    const pid = readPidAt(lockPath);

    // Container safety: if PID is 1 and we're inside a container,
    // the lock file is stale from a previous container lifecycle
    if (pid === 1 && isInsideContainer()) {
      // Only auto-release when probing the default daemon path. A custom
      // lockPath probe shouldn't be allowed to nuke an arbitrary file.
      if (lockPath === defaultLockPath()) releaseLock();
      return null;
    }

    return pid;
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
    mkdirSync(join(lockPath, '..'), { recursive: true });
    const fd = openSync(lockPath, constants.O_WRONLY | constants.O_CREAT, 0o644);
    const result = flock.do_flock(fd, LOCK_EX | LOCK_NB);
    if (result !== 0) {
      closeSync(fd);
      return null;
    }
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
 */
export function writeLockedPort(port: number): void {
  if (lockFd === null) return;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return;
  try {
    const pid = process.pid;
    ftruncateSync(lockFd, 0);
    writeSync(lockFd, `${pid}\n${port}\n`, 0);
  } catch (err) {
    console.error(`[PID] Failed to record port ${port} in lock file: ${err}`);
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
 */
export function getLogPath(): string {
  mkdirSync(LOG_DIR, { recursive: true });
  return LOG_PATH;
}

/**
 * Get the log directory path.
 */
export function getLogDir(): string {
  return LOG_DIR;
}

// ── Helpers ──────────────────────────────────────────────────────────

function isInsideContainer(): boolean {
  if (existsSync('/.dockerenv')) return true;
  try {
    return readFileSync('/proc/1/cgroup', 'utf-8').includes('docker');
  } catch {
    return false;
  }
}

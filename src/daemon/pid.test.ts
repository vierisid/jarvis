import { test, expect, describe, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, mkdtempSync, rmSync, truncateSync, chmodSync, statSync, symlinkSync, linkSync, readdirSync, readlinkSync } from 'node:fs';
import {
  acquireLock,
  acquireLockAt,
  isLocked,
  releaseLock,
  readPid,
  readLockedPort,
  writeLockedPort,
  getPidPath,
  getLogPath,
  getLogDir,
  releaseLockIfUnheld,
  lockTableShowsHolder,
  flockHeldBy,
  mountDeviceOf,
} from './pid.ts';

// The lock lives at `JARVIS_HOME`/jarvis.pid, resolved per call (see
// pid.ts:daemonRootDir). These tests used to flock the developer's REAL
// ~/.jarvis/jarvis.pid, which made them fail whenever anything else held that
// lock — a jarvis daemon running on the dev machine, or a child process leaked
// by an earlier test file that hadn't been reaped yet. Under full-suite load
// that showed up as "Child process failed to acquire lock". Point JARVIS_HOME
// at a throwaway dir instead, the same seam backup.test.ts uses, so this file
// owns its lock and can't collide with anything.
let DATA_DIR: string;
let LOCK_PATH: string;
let prevJarvisHome: string | undefined;

const PID_MODULE = join(import.meta.dir, 'pid.ts');
const READY_SIGNAL = join(tmpdir(), 'jarvis-test-lock-ready');
const HOLDER_SCRIPT = join(tmpdir(), 'jarvis-test-lock-holder.ts');

function cleanup(): void {
  releaseLock();
  try { unlinkSync(READY_SIGNAL); } catch {}
  try { unlinkSync(HOLDER_SCRIPT); } catch {}
}

/**
 * Spawn a child process that acquires the flock and holds it until killed.
 * Returns once the child has confirmed it holds the lock.
 *
 * The child gets this file's isolated JARVIS_HOME explicitly, so it flocks the
 * same throwaway path the parent asserts on rather than inheriting whatever the
 * ambient environment points at.
 */
async function spawnLockHolder(): Promise<{ proc: ReturnType<typeof Bun.spawn>; pid: number }> {
  try { unlinkSync(READY_SIGNAL); } catch {}

  writeFileSync(HOLDER_SCRIPT, `
import { acquireLock } from ${JSON.stringify(PID_MODULE)};
import { writeFileSync } from 'node:fs';
const ok = acquireLock(process.pid);
writeFileSync(${JSON.stringify(READY_SIGNAL)}, ok ? String(process.pid) : 'FAIL');
await Bun.sleep(60000);
`);

  // stderr is piped, not ignored: when the child can't take the lock its reason
  // (pid.ts logs one) is the only thing that explains the failure, and a bare
  // "failed to acquire lock" on a CI runner is undebuggable.
  const proc = Bun.spawn(['bun', HOLDER_SCRIPT], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, JARVIS_HOME: DATA_DIR },
  });

  // MUST be called only after the child has exited: reading the pipe drains it
  // to EOF, and EOF arrives when the process ends. The holder sleeps 60s, so
  // reading it while alive blocks for the full minute and turns a fast
  // lock-acquisition failure into a silent test timeout.
  const killThenStderr = async (): Promise<string> => {
    proc.kill();
    await proc.exited;
    try { return (await new Response(proc.stderr as ReadableStream).text()).trim(); }
    catch { return '<no stderr>'; }
  };

  // 15s, not 5s: the child pays for a cold `bun` start AND the one-time TinyCC
  // compile of flock.c (pid.ts:getFlock). On a loaded 2-core runner that can
  // take several seconds on its own, and a timeout here read as a real bug.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await Bun.sleep(50);
    if (!existsSync(READY_SIGNAL)) continue;

    const content = readFileSync(READY_SIGNAL, 'utf-8').trim();
    if (content === 'FAIL') {
      const err = await killThenStderr();
      throw new Error(
        `Child process failed to acquire lock at ${LOCK_PATH}` +
        `\n  holder stderr: ${err || '<empty>'}` +
        `\n  lock currently held by pid: ${isLocked() ?? 'nobody'}`,
      );
    }
    return { proc, pid: parseInt(content, 10) };
  }

  const err = await killThenStderr();
  throw new Error(`Timed out waiting for child to acquire lock\n  holder stderr: ${err || '<empty>'}`);
}

describe('Process Lock Manager', () => {
  beforeAll(() => {
    prevJarvisHome = process.env.JARVIS_HOME;
    DATA_DIR = mkdtempSync(join(tmpdir(), 'jarvis-pid-test-'));
    process.env.JARVIS_HOME = DATA_DIR;
    LOCK_PATH = join(DATA_DIR, 'jarvis.pid');
  });

  afterAll(() => {
    cleanup();
    if (prevJarvisHome === undefined) delete process.env.JARVIS_HOME;
    else process.env.JARVIS_HOME = prevJarvisHome;
    try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  beforeEach(() => cleanup());
  afterEach(() => cleanup());

  // ── acquireLock ──────────────────────────────────────────────────

  describe('acquireLock', () => {
    test('returns true and creates lock file', () => {
      expect(acquireLock(process.pid)).toBe(true);
      expect(existsSync(LOCK_PATH)).toBe(true);
    });

    test('writes PID to lock file', () => {
      acquireLock(process.pid);
      const content = readFileSync(LOCK_PATH, 'utf-8').trim();
      expect(content).toBe(String(process.pid));
    });

    test('creates ~/.jarvis dir if missing', () => {
      // Dir almost certainly exists already, but acquireLock should not fail
      expect(acquireLock(process.pid)).toBe(true);
    });

    test('second acquire in same process returns false', () => {
      // First fd holds an exclusive flock; second open+flock is denied
      expect(acquireLock(process.pid)).toBe(true);
      expect(acquireLock(process.pid)).toBe(false);
    });

    // The data folder and its lock are this user's alone. Modes are checked
    // under a permissive umask so the result cannot come from the umask.
    describe('permissions', () => {
      let prevUmask: number;
      beforeEach(() => { prevUmask = process.umask(0o022); });
      afterEach(() => {
        process.umask(prevUmask);
        process.env.JARVIS_HOME = DATA_DIR;
      });

      test('creates a missing data folder 0700 and the lock file 0600', () => {
        const fresh = join(DATA_DIR, 'fresh', 'home');
        process.env.JARVIS_HOME = fresh;
        try {
          expect(acquireLock(process.pid)).toBe(true);
          expect(statSync(fresh).mode & 0o777).toBe(0o700);
          expect(statSync(join(fresh, 'jarvis.pid')).mode & 0o777).toBe(0o600);
        } finally {
          releaseLock();
          rmSync(join(DATA_DIR, 'fresh'), { recursive: true, force: true });
        }
      });

      test('narrows an existing lock file to 0600 once it holds it', () => {
        writeFileSync(LOCK_PATH, '99999');
        chmodSync(LOCK_PATH, 0o644);
        expect(acquireLock(process.pid)).toBe(true);
        expect(statSync(LOCK_PATH).mode & 0o777).toBe(0o600);
      });

      test('only the data folder itself is 0700, not parents it had to create', () => {
        const parent = join(DATA_DIR, 'parent');
        const fresh = join(parent, 'home');
        process.env.JARVIS_HOME = fresh;
        try {
          expect(acquireLock(process.pid)).toBe(true);
          expect(statSync(fresh).mode & 0o777).toBe(0o700);
          expect(statSync(parent).mode & 0o777).toBe(0o755);
        } finally {
          releaseLock();
          rmSync(parent, { recursive: true, force: true });
        }
      });

      test('parents it creates are 0755 even under a umask of 0', () => {
        process.umask(0);
        const parent = join(DATA_DIR, 'umask0');
        process.env.JARVIS_HOME = join(parent, 'home');
        try {
          expect(acquireLock(process.pid)).toBe(true);
          expect(statSync(parent).mode & 0o777).toBe(0o755);
        } finally {
          releaseLock();
          rmSync(parent, { recursive: true, force: true });
        }
      });

      test.if(process.platform === 'linux')('refuses a FIFO at the lock path without hanging', () => {
        const dir = join(DATA_DIR, 'fifo');
        mkdirSync(dir, { recursive: true });
        const fifo = join(dir, 'jarvis.pid');
        expect(Bun.spawnSync(['mkfifo', fifo]).exitCode).toBe(0);
        try {
          expect(acquireLockAt(fifo, process.pid)).toBeNull();
          expect(flockHeldBy(process.pid, fifo)).toBeNull();
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }, 5_000);

      test('refuses a lock path that is a symlink, and leaves its target alone', () => {
        const dir = join(DATA_DIR, 'link');
        mkdirSync(dir, { recursive: true });
        const target = join(dir, 'someone-elses-file');
        writeFileSync(target, 'IMPORTANT\n');
        chmodSync(target, 0o644);
        symlinkSync(target, join(dir, 'jarvis.pid'));
        const lock = acquireLockAt(join(dir, 'jarvis.pid'), process.pid);
        try {
          expect(lock).toBeNull();
          expect(readFileSync(target, 'utf-8')).toBe('IMPORTANT\n');
          expect(statSync(target).mode & 0o777).toBe(0o644);
        } finally {
          lock?.release();
          rmSync(dir, { recursive: true, force: true });
        }
      });

      test('refuses a lock path that is a hard link, and leaves the other name alone', () => {
        const dir = join(DATA_DIR, 'hard');
        mkdirSync(dir, { recursive: true });
        const other = join(dir, 'other-file');
        writeFileSync(other, 'IMPORTANT\n');
        linkSync(other, join(dir, 'jarvis.pid'));
        const lock = acquireLockAt(join(dir, 'jarvis.pid'), process.pid);
        try {
          expect(lock).toBeNull();
          expect(readFileSync(other, 'utf-8')).toBe('IMPORTANT\n');
        } finally {
          lock?.release();
          rmSync(dir, { recursive: true, force: true });
        }
      });

      // A child that inherited the lock descriptor would keep the data folder
      // locked after the daemon died, under the daemon's pid in /proc/locks.
      test.if(process.platform === 'linux')('the lock descriptor is close-on-exec', () => {
        expect(acquireLock(process.pid)).toBe(true);
        const fd = readdirSync('/proc/self/fd').find((n) => {
          try { return readlinkSync(`/proc/self/fd/${n}`) === LOCK_PATH; } catch { return false; }
        });
        expect(fd).toBeDefined();
        const flags = /^flags:\s+([0-7]+)/m.exec(readFileSync(`/proc/self/fdinfo/${fd}`, 'utf-8'))![1]!;
        expect(parseInt(flags, 8) & 0o2000000).toBe(0o2000000);
      });

      test('acquireLockAt creates its folder 0700 and its lock file 0600', () => {
        const dir = join(DATA_DIR, 'at', 'dir');
        const lock = acquireLockAt(join(dir, 'jarvis.pid'), process.pid);
        try {
          expect(lock).not.toBeNull();
          expect(statSync(dir).mode & 0o777).toBe(0o700);
          expect(statSync(join(dir, 'jarvis.pid')).mode & 0o777).toBe(0o600);
        } finally {
          lock?.release();
          rmSync(join(DATA_DIR, 'at'), { recursive: true, force: true });
        }
      });
    });
  });

  // ── isLocked ─────────────────────────────────────────────────────

  describe('isLocked', () => {
    test('returns null when no lock file exists', () => {
      expect(isLocked()).toBeNull();
    });

    test('returns null for stale file (file exists, no lock held)', () => {
      mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(LOCK_PATH, '99999');
      // No flock held — probe should succeed → not locked
      expect(isLocked()).toBeNull();
    });

    test('returns PID when lock is held by this process', () => {
      acquireLock(process.pid);
      // isLocked opens a second fd; flock is denied because our fd holds it
      expect(isLocked()).toBe(process.pid);
    });
  });

  // ── releaseLock ──────────────────────────────────────────────────

  describe('releaseLock', () => {
    test('releases lock and removes file', () => {
      acquireLock(process.pid);
      expect(existsSync(LOCK_PATH)).toBe(true);

      releaseLock();
      expect(existsSync(LOCK_PATH)).toBe(false);
      expect(isLocked()).toBeNull();
    });

    test('is idempotent — safe to call without prior acquire', () => {
      releaseLock();
      releaseLock();
      releaseLock();
      // Should not throw
    });

    test('allows re-acquire after release', () => {
      expect(acquireLock(process.pid)).toBe(true);
      releaseLock();
      expect(acquireLock(process.pid)).toBe(true);
    });

    test('multiple acquire/release cycles work', () => {
      for (let i = 0; i < 5; i++) {
        expect(acquireLock(process.pid)).toBe(true);
        expect(isLocked()).toBe(process.pid);
        releaseLock();
        expect(isLocked()).toBeNull();
      }
    });
  });

  // ── readPid ──────────────────────────────────────────────────────

  describe('readPid', () => {
    test('returns null when no file exists', () => {
      expect(readPid()).toBeNull();
    });

    test('returns PID from file', () => {
      mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(LOCK_PATH, '12345');
      expect(readPid()).toBe(12345);
    });

    test('trims whitespace', () => {
      mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(LOCK_PATH, '  42\n');
      expect(readPid()).toBe(42);
    });

    test('returns null for non-numeric content', () => {
      mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(LOCK_PATH, 'not-a-pid');
      expect(readPid()).toBeNull();
    });

    test('returns null for empty file', () => {
      mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(LOCK_PATH, '');
      expect(readPid()).toBeNull();
    });

    test('returns null for zero', () => {
      mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(LOCK_PATH, '0');
      expect(readPid()).toBeNull();
    });

    test('returns null for negative PID', () => {
      mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(LOCK_PATH, '-1');
      expect(readPid()).toBeNull();
    });
  });

  // ── readLockedPort / writeLockedPort ─────────────────────────────

  describe('readLockedPort', () => {
    test('returns null when no lock file exists', () => {
      expect(readLockedPort()).toBeNull();
    });

    test('returns null for legacy PID-only lock file', () => {
      mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(LOCK_PATH, '12345');
      expect(readLockedPort()).toBeNull();
    });

    test('returns the port from a two-line lock file', () => {
      mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(LOCK_PATH, '12345\n9000\n');
      expect(readLockedPort()).toBe(9000);
    });

    test('returns null for out-of-range port', () => {
      mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(LOCK_PATH, '12345\n99999\n');
      expect(readLockedPort()).toBeNull();
    });

    test('returns null for non-numeric port line', () => {
      mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(LOCK_PATH, '12345\nabc\n');
      expect(readLockedPort()).toBeNull();
    });

    test('readPid still works for two-line format', () => {
      mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(LOCK_PATH, '12345\n9000\n');
      expect(readPid()).toBe(12345);
    });
  });

  describe('writeLockedPort', () => {
    test('is a no-op when no lock is held by this process', () => {
      // No acquireLock — lockFd is null.
      writeLockedPort(9000);
      expect(existsSync(LOCK_PATH)).toBe(false);
    });

    test('records port alongside PID when lock is held', () => {
      acquireLock(process.pid);
      writeLockedPort(9000);
      const content = readFileSync(LOCK_PATH, 'utf-8');
      expect(content.split(/\r?\n/)[0]).toBe(String(process.pid));
      expect(readLockedPort()).toBe(9000);
      expect(readPid()).toBe(process.pid);
    });

    test('refuses invalid ports, and says so', () => {
      // Out loud, not silently. This no-op is half of #550: a quoted
      // `daemon.port` arrived here as the STRING "8080", nothing was recorded,
      // and `jarvis stop` then fell back to 3142 and signalled an unrelated
      // listener. The config loader coerces the port now, so reaching this is a
      // bug upstream and has to be visible in the daemon's log.
      const refusals: string[] = [];
      const realError = console.error;
      console.error = (...args: unknown[]) => { refusals.push(args.map(String).join(' ')); };
      try {
        acquireLock(process.pid);
        writeLockedPort(0);
        writeLockedPort(70000);
        writeLockedPort(Number.NaN);
        // The string case the coercion exists to prevent, which TypeScript
        // alone cannot: this value comes from YAML.
        writeLockedPort('8080' as unknown as number);
      } finally {
        console.error = realError;
      }

      expect(readLockedPort()).toBeNull();
      expect(readPid()).toBe(process.pid);
      expect(refusals).toHaveLength(4);
      for (const line of refusals) {
        expect(line).toContain('Refusing to record');
        expect(line).toContain('jarvis stop');
      }
      // Each names the value it refused, NaN as NaN rather than as "null".
      expect(refusals[0]).toContain('record 0 as');
      expect(refusals[1]).toContain('70000');
      expect(refusals[2]).toContain('NaN');
      expect(refusals[3]).toContain('"8080"');
    });

    test('overwrites an earlier recorded port', () => {
      acquireLock(process.pid);
      writeLockedPort(9000);
      writeLockedPort(3142);
      expect(readLockedPort()).toBe(3142);
    });
  });

  // ── path getters ─────────────────────────────────────────────────

  describe('path getters', () => {
    test('getPidPath tracks JARVIS_HOME', () => {
      expect(getPidPath()).toBe(join(DATA_DIR, 'jarvis.pid'));
    });

    test('getPidPath falls back to ~/.jarvis/jarvis.pid with no JARVIS_HOME', () => {
      // The path is resolved per call, so unsetting the var mid-test is enough
      // to exercise the default branch that the isolated DATA_DIR otherwise hides.
      delete process.env.JARVIS_HOME;
      try {
        expect(getPidPath()).toBe(join(homedir(), '.jarvis', 'jarvis.pid'));
      } finally {
        process.env.JARVIS_HOME = DATA_DIR;
      }
    });

    test('getLogPath creates a missing data folder 0700, as the lock does', () => {
      const prevUmask = process.umask(0o022);
      const fresh = join(DATA_DIR, 'logfresh', 'home');
      process.env.JARVIS_HOME = fresh;
      try {
        getLogPath();
        expect(statSync(fresh).mode & 0o777).toBe(0o700);
      } finally {
        process.umask(prevUmask);
        process.env.JARVIS_HOME = DATA_DIR;
        rmSync(join(DATA_DIR, 'logfresh'), { recursive: true, force: true });
      }
    });

    test('getLogPath returns path and creates logs dir', () => {
      const logPath = getLogPath();
      expect(logPath).toBe(join(DATA_DIR, 'logs', 'jarvis.log'));
      expect(existsSync(join(DATA_DIR, 'logs'))).toBe(true);
    });

    test('getLogDir returns logs directory', () => {
      expect(getLogDir()).toBe(join(DATA_DIR, 'logs'));
    });

    test('logs and lock resolve under the SAME root', () => {
      // The bug this guards: logs were built from homedir() at import time
      // while the lock honored JARVIS_HOME, so the daemon locked one root and
      // logged to another.
      expect(getLogDir().startsWith(DATA_DIR)).toBe(true);
      expect(getPidPath().startsWith(DATA_DIR)).toBe(true);
    });

    test('getLogDir falls back to ~/.jarvis/logs with no JARVIS_HOME', () => {
      delete process.env.JARVIS_HOME;
      try {
        expect(getLogDir()).toBe(join(homedir(), '.jarvis', 'logs'));
      } finally {
        process.env.JARVIS_HOME = DATA_DIR;
      }
    });
  });

  // ── releaseLockIfUnheld ──────────────────────────────────────────
  //
  // The guard behind `jarvis stop` / `update` / `uninstall`. It must never
  // unlink a lockfile some process still holds — doing so lets a second daemon
  // start against the same data dir.

  describe('releaseLockIfUnheld', () => {
    test('clears a stale lockfile that nobody holds', () => {
      mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(LOCK_PATH, '99999');
      expect(releaseLockIfUnheld()).toBe(true);
      expect(existsSync(LOCK_PATH)).toBe(false);
    });

    test('refuses a held lock whose pid is unreadable', async () => {
      const { proc } = await spawnLockHolder();
      try {
        // acquireLock truncates before writing the pid, so a held lock is
        // briefly empty. Reproduce that window exactly.
        truncateSync(LOCK_PATH, 0);

        // isLocked() cannot tell this from "free" — it reads the pid and gets
        // nothing. This is precisely why the guard must not be built on it.
        expect(isLocked()).toBeNull();

        expect(releaseLockIfUnheld()).toBe(false);
        expect(existsSync(LOCK_PATH)).toBe(true);
      } finally {
        proc.kill();
        await proc.exited;
      }
    }, 20_000);

    // Root bypasses permission bits, so the unreadable case can't be staged.
    test.skipIf(typeof process.getuid === 'function' && process.getuid() === 0)(
      'refuses a lockfile it cannot even open',
      async () => {
        const { proc } = await spawnLockHolder();
        try {
          chmodSync(LOCK_PATH, 0o000);
          expect(releaseLockIfUnheld()).toBe(false);
          expect(existsSync(LOCK_PATH)).toBe(true);
        } finally {
          try { chmodSync(LOCK_PATH, 0o644); } catch { /* ignore */ }
          proc.kill();
          await proc.exited;
        }
      }, 20_000);
  });

  // ── cross-process locking ────────────────────────────────────────

  describe('cross-process locking', () => {
    let childProc: ReturnType<typeof Bun.spawn> | null = null;

    afterEach(async () => {
      if (childProc) {
        childProc.kill();
        await childProc.exited;
        childProc = null;
      }
      cleanup();
    });

    test('isLocked detects lock held by another process', async () => {
      const { proc, pid } = await spawnLockHolder();
      childProc = proc;

      const result = isLocked();
      expect(result).toBe(pid);
    }, { timeout: 15000 });

    test('acquireLock fails when another process holds lock', async () => {
      const { proc } = await spawnLockHolder();
      childProc = proc;

      expect(acquireLock(process.pid)).toBe(false);
    }, { timeout: 15000 });

    test('lock is released when holder is SIGKILLed', async () => {
      const { proc } = await spawnLockHolder();
      childProc = proc;

      // Lock is held
      expect(isLocked()).not.toBeNull();

      // SIGKILL — OS closes all fds, releasing the flock
      proc.kill(9);
      await proc.exited;
      childProc = null;

      // Lock is now free
      expect(isLocked()).toBeNull();
    }, { timeout: 15000 });

    test('can acquire lock after previous holder crashes', async () => {
      const { proc } = await spawnLockHolder();
      childProc = proc;

      proc.kill(9);
      await proc.exited;
      childProc = null;

      // New instance should succeed immediately
      expect(acquireLock(process.pid)).toBe(true);
      expect(readPid()).toBe(process.pid);
    }, { timeout: 15000 });

    test('lock survives SIGTERM of holder (graceful)', async () => {
      const { proc, pid } = await spawnLockHolder();
      childProc = proc;

      // SIGTERM — child exits, OS releases flock
      proc.kill(15);
      await proc.exited;
      childProc = null;

      // Lock freed after process exits
      expect(isLocked()).toBeNull();
      expect(acquireLock(process.pid)).toBe(true);
    }, { timeout: 15000 });
  });

  // ── native Windows guard (#252) ──────────────────────────────────
  //
  // On native Windows the daemon is unsupported and `flock.c` (POSIX-only)
  // cannot be compiled. The cc() compile must be deferred so importing the
  // module never crashes before the CLI's platform guard fires, and any
  // flock path that *is* reached must surface a clear message rather than a
  // low-level TinyCC `sys/file.h not found` error.

  describe('native Windows guard', () => {
    const PROBE_SCRIPT = join(tmpdir(), 'jarvis-test-win32-probe.ts');
    const PROBE_HOME = join(tmpdir(), 'jarvis-test-win32-home');

    afterEach(() => {
      try { unlinkSync(PROBE_SCRIPT); } catch {}
      try { rmSync(PROBE_HOME, { recursive: true, force: true }); } catch {}
    });

    /** Run a snippet in a child process with `process.platform` faked to win32. */
    async function runOnFakeWin32(body: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
      writeFileSync(PROBE_SCRIPT, `
Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
${body}
`);
      const proc = Bun.spawn(['bun', PROBE_SCRIPT], {
        stdio: ['ignore', 'pipe', 'pipe'],
        // Isolate from the real ~/.jarvis so the probe can't touch a live lock.
        env: { ...process.env, HOME: PROBE_HOME, USERPROFILE: PROBE_HOME },
      });
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const exitCode = await proc.exited;
      return { stdout, stderr, exitCode };
    }

    // Smoke test only: on a POSIX CI host `<sys/file.h>` exists, so even the
    // pre-fix eager compile would succeed here — this can only truly fail on
    // real Windows. The genuine regression guard is the next test.
    test('importing the module is side-effect-free (smoke)', async () => {
      const { stdout, stderr, exitCode } = await runOnFakeWin32(`
await import(${JSON.stringify(PID_MODULE)});
console.log('IMPORT_OK');
`);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('IMPORT_OK');
      expect(stderr).not.toContain('sys/file.h');
    }, { timeout: 15000 });

    // Real regression guard: pre-fix, `acquireLock` ran the eager-compiled
    // flock against the real POSIX libc (no win32 guard existed), so stderr
    // would NOT contain the support message — this test fails on the old code.
    test('acquireLock surfaces a clear unsupported message, not a TinyCC error', async () => {
      const { stderr, exitCode } = await runOnFakeWin32(`
const { acquireLock } = await import(${JSON.stringify(PID_MODULE)});
const ok = acquireLock(process.pid);
console.log('ACQUIRE=' + ok);
`);
      expect(exitCode).toBe(0);
      // The clear, immediate daemon-support message — not a TinyCC header error.
      expect(stderr).toContain('not compatible with native Windows');
      expect(stderr).toContain('WSL2 or Docker');
      expect(stderr).not.toContain('sys/file.h');
    }, { timeout: 15000 });
  });
});

describe('lockTableShowsHolder', () => {
  // A real /proc/locks line, from a flock in a btrfs subvolume (measured in a
  // privileged container): the table names the filesystem's device 00:ad, not
  // the subvolume's own st_dev 00:df.
  const table = [
    '35: OFDLCK ADVISORY  READ -1 00:ad:257 0 EOF',
    '36: FLOCK  ADVISORY  WRITE 18 00:ad:257 0 EOF',
    '36: -> FLOCK  ADVISORY  WRITE 19 00:ad:257 0 EOF',
    '37: POSIX  ADVISORY  WRITE 20 00:ad:257 0 EOF',
  ].join('\n');

  test('matches the holder on the mount device when stat device names no lock', () => {
    expect(lockTableShowsHolder(table, 18, 257n, [0n, 0xdfn], [0n, 0xadn])).toBe(true);
  });

  test('a device that is only the subvolume st_dev does not match', () => {
    expect(lockTableShowsHolder(table, 18, 257n, [0n, 0xdfn], null)).toBe(false);
  });

  test('waiters, POSIX and OFD locks never count, nor another inode or pid', () => {
    for (const pid of [19, 20, -1]) expect(lockTableShowsHolder(table, pid, 257n, [0n, 0xadn])).toBe(false);
    expect(lockTableShowsHolder(table, 18, 258n, [0n, 0xadn])).toBe(false);
  });

  test('a lone read flock on the mount device is not the holder', () => {
    expect(lockTableShowsHolder('40: FLOCK  ADVISORY  READ 30 00:ad:257 0 EOF', 30, 257n, [0n, 0xdfn], [0n, 0xadn])).toBe(false);
  });

  test('a read flock is not the holder', () => {
    expect(lockTableShowsHolder('38: FLOCK  ADVISORY  READ  21 00:ad:257 0 EOF', 21, 257n, [0n, 0xadn])).toBe(false);
  });

  // Inode numbers repeat across btrfs subvolumes, so on the mount device alone
  // two different files can share a key. Then it proves nothing.
  test('on the mount device, two flocks on one inode number prove nothing', () => {
    const two = table + '\n40: FLOCK  ADVISORY  WRITE 30 00:ad:257 0 EOF';
    expect(lockTableShowsHolder(two, 18, 257n, [0n, 0xdfn], [0n, 0xadn])).toBe(false);
    expect(lockTableShowsHolder(two, 30, 257n, [0n, 0xdfn], [0n, 0xadn])).toBe(false);
  });

  test('an exact device match is never second-guessed by the mount device', () => {
    const t = '50: FLOCK  ADVISORY  WRITE 7 08:40:99 0 EOF\n51: FLOCK  ADVISORY  WRITE 8 00:ad:99 0 EOF';
    expect(lockTableShowsHolder(t, 7, 99n, [8n, 0x40n], [0n, 0xadn])).toBe(true);
    expect(lockTableShowsHolder(t, 8, 99n, [8n, 0x40n], [0n, 0xadn])).toBe(false);
  });
});

describe.if(process.platform === 'linux')('flockHeldBy', () => {
  test('names this process for a lock it holds, nobody else, and null for no file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jarvis-flock-held-'));
    const lockPath = join(dir, 'jarvis.pid');
    const { acquireLockAt } = require('./pid.ts') as typeof import('./pid.ts');
    const lock = acquireLockAt(lockPath, process.pid);
    try {
      expect(lock).not.toBeNull();
      expect(flockHeldBy(process.pid, lockPath)).toBe(true);
      expect(flockHeldBy(process.pid + 1_000_000, lockPath)).toBe(false);
    } finally {
      lock?.release();
    }
    expect(flockHeldBy(process.pid, lockPath)).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe.if(process.platform === 'linux')('mountDeviceOf', () => {
  // On a filesystem without subvolumes the mount's device is the file's st_dev,
  // which proves the fdinfo and mountinfo lookups find the right mount. (The
  // btrfs case, where they differ, needs root to set up and was measured in a
  // privileged container.)
  test('is the device stat reports, on a plain filesystem', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jarvis-mountdev-'));
    const file = join(dir, 'f');
    writeFileSync(file, '');
    try {
      const dev = statSync(file, { bigint: true }).dev;
      expect(mountDeviceOf(file)).toEqual([((dev >> 8n) & 0xfffn) | ((dev >> 32n) & ~0xfffn), (dev & 0xffn) | ((dev >> 12n) & ~0xffn)]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('is null for a missing file', () => {
    expect(mountDeviceOf(join(tmpdir(), 'jarvis-no-such-file-for-mountdev'))).toBeNull();
  });
});

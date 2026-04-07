import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import {
  acquireLock,
  isLocked,
  releaseLock,
  readPid,
  getPidPath,
  getLogPath,
  getLogDir,
} from './pid.ts';

const JARVIS_DIR = join(homedir(), '.jarvis');
const LOCK_PATH = join(JARVIS_DIR, 'jarvis.pid');
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

  const proc = Bun.spawn(['bun', HOLDER_SCRIPT], {
    stdio: ['ignore', 'ignore', 'ignore'],
  });

  for (let i = 0; i < 50; i++) {
    await Bun.sleep(100);
    if (existsSync(READY_SIGNAL)) {
      const content = readFileSync(READY_SIGNAL, 'utf-8').trim();
      if (content === 'FAIL') {
        proc.kill();
        await proc.exited;
        throw new Error('Child process failed to acquire lock');
      }
      return { proc, pid: parseInt(content, 10) };
    }
  }
  proc.kill();
  await proc.exited;
  throw new Error('Timed out waiting for child to acquire lock');
}

describe('Process Lock Manager', () => {
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
  });

  // ── isLocked ─────────────────────────────────────────────────────

  describe('isLocked', () => {
    test('returns null when no lock file exists', () => {
      expect(isLocked()).toBeNull();
    });

    test('returns null for stale file (file exists, no lock held)', () => {
      mkdirSync(JARVIS_DIR, { recursive: true });
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
      mkdirSync(JARVIS_DIR, { recursive: true });
      writeFileSync(LOCK_PATH, '12345');
      expect(readPid()).toBe(12345);
    });

    test('trims whitespace', () => {
      mkdirSync(JARVIS_DIR, { recursive: true });
      writeFileSync(LOCK_PATH, '  42\n');
      expect(readPid()).toBe(42);
    });

    test('returns null for non-numeric content', () => {
      mkdirSync(JARVIS_DIR, { recursive: true });
      writeFileSync(LOCK_PATH, 'not-a-pid');
      expect(readPid()).toBeNull();
    });

    test('returns null for empty file', () => {
      mkdirSync(JARVIS_DIR, { recursive: true });
      writeFileSync(LOCK_PATH, '');
      expect(readPid()).toBeNull();
    });

    test('returns null for zero', () => {
      mkdirSync(JARVIS_DIR, { recursive: true });
      writeFileSync(LOCK_PATH, '0');
      expect(readPid()).toBeNull();
    });

    test('returns null for negative PID', () => {
      mkdirSync(JARVIS_DIR, { recursive: true });
      writeFileSync(LOCK_PATH, '-1');
      expect(readPid()).toBeNull();
    });
  });

  // ── path getters ─────────────────────────────────────────────────

  describe('path getters', () => {
    test('getPidPath returns ~/.jarvis/jarvis.pid', () => {
      expect(getPidPath()).toBe(join(homedir(), '.jarvis', 'jarvis.pid'));
    });

    test('getLogPath returns path and creates logs dir', () => {
      const logPath = getLogPath();
      expect(logPath).toBe(join(JARVIS_DIR, 'logs', 'jarvis.log'));
      expect(existsSync(join(JARVIS_DIR, 'logs'))).toBe(true);
    });

    test('getLogDir returns logs directory', () => {
      expect(getLogDir()).toBe(join(JARVIS_DIR, 'logs'));
    });
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
});

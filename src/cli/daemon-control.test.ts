/**
 * Tests for the shared daemon-stop helper.
 *
 * The invariant under test: the lockfile is cleared ONLY when the holder is
 * confirmed gone. releaseLock() unlinks the path unconditionally, so a stop
 * that fails to kill the daemon must leave the lock alone — otherwise
 * isLocked() reports nothing and a second daemon starts against the same data
 * dir while the first is still writing to it.
 */
import { test, expect, describe, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync, mkdtempSync, rmSync, readFileSync, unlinkSync } from 'node:fs';
import { stopDaemonGracefully } from './daemon-control.ts';
import { isLocked, releaseLock } from '../daemon/pid.ts';

const PID_MODULE = join(import.meta.dir, '..', 'daemon', 'pid.ts');

let DATA_DIR: string;
let LOCK_PATH: string;
let prevJarvisHome: string | undefined;

const realKill = process.kill.bind(process);

/** Spawn a child holding the real flock, and wait until it confirms. */
async function spawnHolder(opts: { ignoreSigterm?: boolean } = {}): Promise<ReturnType<typeof Bun.spawn>> {
  const readySignal = join(DATA_DIR, `ready-${Math.floor(performance.now() * 1000)}`);
  const script = join(DATA_DIR, 'holder.ts');
  await Bun.write(script, `
import { acquireLock } from ${JSON.stringify(PID_MODULE)};
import { writeFileSync } from 'node:fs';
${opts.ignoreSigterm ? "process.on('SIGTERM', () => {});" : ''}
const ok = acquireLock(process.pid);
writeFileSync(${JSON.stringify(readySignal)}, ok ? String(process.pid) : 'FAIL');
await Bun.sleep(60000);
`);

  const proc = Bun.spawn(['bun', script], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, JARVIS_HOME: DATA_DIR },
  });

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await Bun.sleep(50);
    if (!existsSync(readySignal)) continue;
    const content = readFileSync(readySignal, 'utf-8').trim();
    try { unlinkSync(readySignal); } catch { /* ignore */ }
    if (content === 'FAIL') {
      proc.kill();
      await proc.exited;
      throw new Error('holder could not acquire the lock');
    }
    return proc;
  }
  proc.kill();
  await proc.exited;
  throw new Error('timed out waiting for the holder to acquire the lock');
}

describe('stopDaemonGracefully', () => {
  beforeAll(() => {
    prevJarvisHome = process.env.JARVIS_HOME;
    DATA_DIR = mkdtempSync(join(tmpdir(), 'jarvis-daemon-control-test-'));
    process.env.JARVIS_HOME = DATA_DIR;
    LOCK_PATH = join(DATA_DIR, 'jarvis.pid');
  });

  afterAll(() => {
    releaseLock();
    if (prevJarvisHome === undefined) delete process.env.JARVIS_HOME;
    else process.env.JARVIS_HOME = prevJarvisHome;
    try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  beforeEach(() => releaseLock());
  afterEach(() => {
    process.kill = realKill;
    releaseLock();
  });

  test('reports no daemon when nothing holds the lock', async () => {
    const result = await stopDaemonGracefully();
    expect(result).toEqual({ wasRunning: false, pid: null, graceful: true, stopped: true });
  });

  test('stops a live daemon and clears the lockfile', async () => {
    const holder = await spawnHolder();
    expect(isLocked()).not.toBeNull();

    const result = await stopDaemonGracefully({ timeoutMs: 5000, pollIntervalMs: 100 });
    await holder.exited;

    expect(result.wasRunning).toBe(true);
    expect(result.stopped).toBe(true);
    expect(existsSync(LOCK_PATH)).toBe(false);
  }, 30_000);

  test('escalates to SIGKILL when the daemon ignores SIGTERM', async () => {
    const holder = await spawnHolder({ ignoreSigterm: true });

    const result = await stopDaemonGracefully({ timeoutMs: 1500, pollIntervalMs: 100 });
    await holder.exited;

    expect(result.wasRunning).toBe(true);
    expect(result.graceful).toBe(false); // SIGTERM did not do it
    expect(result.stopped).toBe(true);   // SIGKILL did
    expect(existsSync(LOCK_PATH)).toBe(false);
  }, 30_000);

  // The regression this whole change exists for.
  test('leaves the lockfile intact when the daemon cannot be signalled (EPERM)', async () => {
    const holder = await spawnHolder();
    const heldPid = isLocked();
    expect(heldPid).not.toBeNull();

    // Simulate a daemon owned by another user: every signal — including the
    // liveness probe — raises EPERM. That is the case where the process is
    // very much alive but not ours to kill.
    process.kill = ((pid: number, signal?: string | number) => {
      if (pid === heldPid) {
        const err = new Error('kill EPERM') as NodeJS.ErrnoException;
        err.code = 'EPERM';
        throw err;
      }
      return realKill(pid, signal as never);
    }) as typeof process.kill;

    const result = await stopDaemonGracefully({ timeoutMs: 600, pollIntervalMs: 100 });
    process.kill = realKill;

    expect(result.wasRunning).toBe(true);
    expect(result.stopped).toBe(false);
    // The live holder's lock must survive — this is what used to be deleted.
    expect(existsSync(LOCK_PATH)).toBe(true);
    expect(isLocked()).toBe(heldPid);

    holder.kill(9);
    await holder.exited;
  }, 30_000);
});

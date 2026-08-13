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

/**
 * Spawn a child that spins until it can take the lock, the way a service
 * manager relaunches the daemon the moment the old one dies (launchd
 * KeepAlive=true, systemd Restart=). Returns immediately — it cannot acquire
 * anything until the current holder exits.
 */
async function spawnSupervisedReplacement(): Promise<ReturnType<typeof Bun.spawn>> {
  const stamp = Math.floor(performance.now() * 1000);
  const spinningSignal = join(DATA_DIR, `replacement-spinning-${stamp}`);
  const script = join(DATA_DIR, `replacement-${stamp}.ts`);

  // The first acquireLock attempt is expected to FAIL (the original still holds
  // the lock) — its purpose is to pay the one-time TinyCC compile of flock.c
  // before we signal "spinning", so the replacement can win the lock inside a
  // single poll interval rather than racing a cold start against it.
  await Bun.write(script, `
import { acquireLock } from ${JSON.stringify(PID_MODULE)};
import { writeFileSync } from 'node:fs';
let got = acquireLock(process.pid);
writeFileSync(${JSON.stringify(spinningSignal)}, '1');
while (!got) { await Bun.sleep(25); got = acquireLock(process.pid); }
await Bun.sleep(60000);
`);

  const proc = Bun.spawn(['bun', script], {
    stdio: ['ignore', 'ignore', 'ignore'],
    env: { ...process.env, JARVIS_HOME: DATA_DIR },
  });

  // Block until it is actually spinning; otherwise the test races a cold `bun`
  // start and intermittently sees the lock go free.
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (existsSync(spinningSignal)) return proc;
    await Bun.sleep(25);
  }
  proc.kill();
  await proc.exited;
  throw new Error('replacement never started spinning');
}

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
    // A daemon that never exited did not exit "gracefully".
    expect(result.graceful).toBe(false);
    // The live holder's lock must survive — this is what used to be deleted.
    expect(existsSync(LOCK_PATH)).toBe(true);
    expect(isLocked()).toBe(heldPid);

    holder.kill(9);
    await holder.exited;
  }, 30_000);

  // The relaunch case: checking "is the pid we signalled gone" is not enough,
  // because a service manager brings the daemon straight back under a NEW pid.
  // The old pid is then dead, and a pid-based guard would unlink the lockfile
  // the live replacement is holding.
  test('leaves the lockfile intact when a supervisor relaunches the daemon', async () => {
    const original = await spawnHolder();
    const originalPid = isLocked();
    expect(originalPid).not.toBeNull();

    // Already spinning (and past its cold start) before the stop begins; it can
    // only win the lock once `original` is killed.
    const replacement = await spawnSupervisedReplacement();

    // 500ms poll: `original` dies on SIGTERM, and the replacement — already
    // warm, retrying every 25ms — claims the lock well within the interval
    // before stopDaemonGracefully looks again.
    const result = await stopDaemonGracefully({ timeoutMs: 5000, pollIntervalMs: 500 });
    await original.exited;

    const newPid = isLocked();
    expect(newPid).not.toBeNull();
    expect(newPid).not.toBe(originalPid); // a different process holds it now
    expect(result.stopped).toBe(false);   // a daemon IS running against this dir
    expect(existsSync(LOCK_PATH)).toBe(true);

    replacement.kill(9);
    await replacement.exited;
  }, 45_000);
});

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stopDaemonGracefully } from './daemon-control.ts';
import { holdsJarvisLock } from './lifecycle.ts';

/**
 * With a daemon holding the lock, `jarvis stop` (bin/jarvis.ts cmdStop) and
 * stopDaemonGracefully (`jarvis update`, `jarvis uninstall`) signal the pid
 * the lock file names. The flock proves that SOME process holds the lock, not
 * that it is that pid: a daemon in a container writes its own pid namespace's
 * number (1, in the shipped image), which outside the container is another
 * process, and a pid can be reused once its process is gone. So the pid is
 * signalled only once it is shown to hold this data folder's lock, before
 * SIGTERM and again before SIGKILL.
 *
 * Every process signalled here is one this file spawned. JARVIS_HOME and HOME
 * point into this file's own temp folder, so the real ~/.jarvis is never read
 * or written.
 */

const SANDBOX = mkdtempSync(join(tmpdir(), 'jarvis-stop-holder-'));
const PACKAGE_ROOT = join(import.meta.dir, '..', '..');
const PID_MODULE = join(PACKAGE_ROOT, 'src', 'daemon', 'pid.ts');
const HARDENING_MODULE = join(PACKAGE_ROOT, 'src', 'daemon', 'process-hardening.ts');

type Child = { pid: number; exited: Promise<number>; kill: () => Promise<void> };
const spawned: Child[] = [];

afterEach(async () => {
  for (const child of spawned.splice(0)) await child.kill();
});

afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true });
});

let seq = 0;
function dataFolder(name: string): { home: string; jarvisHome: string; lockPath: string } {
  const home = join(SANDBOX, `${name}-${++seq}`);
  const jarvisHome = join(home, '.jarvis');
  mkdirSync(jarvisHome, { recursive: true });
  return { home, jarvisHome, lockPath: join(jarvisHome, 'jarvis.pid') };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Wait for a READY line on stdout; returns the child. */
async function spawnReady(script: string, env: Record<string, string | undefined>): Promise<Child> {
  const child = Bun.spawn([process.execPath, '--eval', script], { env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const kill = async () => {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    await child.exited;
  };
  const entry = { pid: child.pid, exited: child.exited, kill };
  spawned.push(entry);
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let seen = '';
  // 20s: a cold `bun` start plus the one-time TinyCC compile of flock.c.
  const deadline = Date.now() + 20_000;
  while (!seen.includes('\n') && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    seen += decoder.decode(value, { stream: true });
  }
  reader.releaseLock();
  if (!seen.startsWith('READY')) {
    await kill();
    const err = await new Response(child.stderr).text();
    throw new Error(`child did not get ready: ${JSON.stringify(seen)} ${err}`);
  }
  return entry;
}

/** A process that is not a Jarvis daemon: it holds nothing open. */
function spawnBystander(): Promise<Child> {
  return spawnReady(`console.log('READY'); setInterval(() => {}, 1 << 30);`, { ...process.env });
}

/**
 * A daemon stand-in holding the flock on `jarvisHome`'s lock file, the way the
 * daemon does. `writePid` is the pid it writes into the file (its own unless
 * told otherwise). With `onSigterm: 'let-go'` it answers SIGTERM by releasing
 * the lock and staying alive, which is what a reused pid looks like by the
 * time SIGKILL is due: alive, and no longer the lock's holder.
 */
function spawnHolder(jarvisHome: string, opts: { writePid?: number; onSigterm?: 'let-go'; harden?: boolean } = {}): Promise<Child> {
  const script = `
    const { acquireLock, releaseLock } = await import(${JSON.stringify(PID_MODULE)});
    const writePid = Number(process.env.TEST_WRITE_PID || process.pid);
    if (process.env.TEST_ON_SIGTERM === 'let-go') process.on('SIGTERM', () => { releaseLock(); });
    if (!acquireLock(writePid)) { console.log('FAIL'); process.exit(1); }
    if (process.env.TEST_HARDEN === '1') {
      // What the daemon does at boot (src/daemon/index.ts), and what makes its
      // /proc/<pid>/fd unreadable to everyone else.
      const { hardenProcessInspection } = await import(${JSON.stringify(HARDENING_MODULE)});
      const outcome = hardenProcessInspection({ log: () => {}, warn: () => {} });
      if (outcome.kind !== 'hardened') { console.log('NOT-HARDENED ' + JSON.stringify(outcome)); process.exit(1); }
    }
    console.log('READY');
    setInterval(() => {}, 1 << 30);
  `;
  return spawnReady(script, {
    ...process.env,
    JARVIS_HOME: jarvisHome,
    TEST_WRITE_PID: opts.writePid === undefined ? undefined : String(opts.writePid),
    TEST_ON_SIGTERM: opts.onSigterm,
    TEST_HARDEN: opts.harden ? '1' : undefined,
  });
}

function cliEnv(home: string, jarvisHome: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, HOME: home, JARVIS_HOME: jarvisHome, JARVIS_PORT: undefined };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  return env;
}

/** A loopback port nothing listens on (bound by the kernel, then closed). */
function freePort(): number {
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') });
  const port = server.port as number;
  server.stop(true);
  return port;
}

async function runStop(home: string, jarvisHome: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, join(PACKAGE_ROOT, 'bin', 'jarvis.ts'), 'stop', '--port', String(freePort())], {
    env: cliEnv(home, jarvisHome),
    cwd: home,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
}

describe('`jarvis stop` with a daemon holding the lock', () => {
  test('does not signal a pid named in the lock file that does not hold the lock', async () => {
    const { home, jarvisHome, lockPath } = dataFolder('cli-term');
    const bystander = await spawnBystander();
    const holder = await spawnHolder(jarvisHome, { writePid: bystander.pid });
    expect(readFileSync(lockPath, 'utf-8')).toBe(String(bystander.pid));

    const { code, stdout, stderr } = await runStop(home, jarvisHome);

    expect(alive(bystander.pid)).toBe(true);
    expect(alive(holder.pid)).toBe(true);
    expect(existsSync(lockPath)).toBe(true);
    expect(code).toBe(1);
    expect(stdout).not.toContain(`Stopping JARVIS daemon (PID ${bystander.pid})`);
    expect(stderr).toContain(`PID ${bystander.pid}`);
    expect(stderr).toContain('could not be shown to hold the lock');
  }, 60_000);

  test('does not SIGKILL a pid that no longer holds the lock when the drain deadline passes', async () => {
    const { home, jarvisHome, lockPath } = dataFolder('cli-kill');
    // drain_deadline_ms 0 leaves the CLI's fixed 20s margin before SIGKILL.
    writeFileSync(join(home, '.jarvis', 'config.yaml'), 'daemon:\n  drain_deadline_ms: 0\n');
    const holder = await spawnHolder(jarvisHome, { onSigterm: 'let-go' });

    const { code, stdout } = await runStop(home, jarvisHome);

    expect(stdout).toContain(`Stopping JARVIS daemon (PID ${holder.pid})`);
    expect(stdout).not.toContain('sending SIGKILL');
    expect(alive(holder.pid)).toBe(true);
    // The lock was let go of, so nothing holds it and it was cleared.
    expect(code).toBe(0);
    expect(existsSync(lockPath)).toBe(false);
  }, 60_000);
});

describe('stopDaemonGracefully', () => {
  const saved = process.env.JARVIS_HOME;
  afterEach(() => {
    if (saved === undefined) delete process.env.JARVIS_HOME;
    else process.env.JARVIS_HOME = saved;
  });

  test('does not signal a pid named in the lock file that does not hold the lock', async () => {
    const { jarvisHome, lockPath } = dataFolder('helper-term');
    const bystander = await spawnBystander();
    const holder = await spawnHolder(jarvisHome, { writePid: bystander.pid });
    process.env.JARVIS_HOME = jarvisHome;

    const started: number[] = [];
    const result = await stopDaemonGracefully({ timeoutMs: 600, pollIntervalMs: 100, onStart: (pid) => started.push(pid) });

    expect(alive(bystander.pid)).toBe(true);
    expect(alive(holder.pid)).toBe(true);
    expect(existsSync(lockPath)).toBe(true);
    expect(started).toEqual([]);
    expect(result).toEqual({ wasRunning: true, pid: bystander.pid, graceful: false, stopped: false, notHolder: true });
  }, 60_000);

  test('does not SIGKILL a pid that no longer holds the lock when the timeout passes', async () => {
    const { jarvisHome, lockPath } = dataFolder('helper-kill');
    const holder = await spawnHolder(jarvisHome, { onSigterm: 'let-go' });
    process.env.JARVIS_HOME = jarvisHome;

    const forced: number[] = [];
    // 3s: the child's SIGTERM handler must have let go of the lock before the
    // recheck, even on a loaded runner.
    const result = await stopDaemonGracefully({ timeoutMs: 3000, pollIntervalMs: 100, onForce: (pid) => forced.push(pid) });

    expect(forced).toEqual([]);
    expect(alive(holder.pid)).toBe(true);
    expect(result.stopped).toBe(true);
    expect(result.graceful).toBe(false);
    expect(existsSync(lockPath)).toBe(false);
  }, 60_000);
});

// The real daemon hardens itself at boot (PR_SET_DUMPABLE 0, Linux only), which
// makes its /proc/<pid>/fd unreadable even to its own user. The holder check
// must still recognise it, or no stop could ever signal a default daemon.
describe.if(process.platform === 'linux')('a hardened daemon (Linux)', () => {
  test('holdsJarvisLock recognises it', async () => {
    const { lockPath, jarvisHome } = dataFolder('hardened-holds');
    const holder = await spawnHolder(jarvisHome, { harden: true });
    expect(() => readdirSync(`/proc/${holder.pid}/fd`)).toThrow();
    expect(await holdsJarvisLock(holder.pid, lockPath)).toBe(true);
  }, 60_000);

  test('`jarvis stop` stops it', async () => {
    const { home, jarvisHome, lockPath } = dataFolder('hardened-cli');
    const holder = await spawnHolder(jarvisHome, { harden: true });

    const { code, stdout, stderr } = await runStop(home, jarvisHome);

    expect(code).toBe(0);
    expect(stderr).not.toContain('not signalled');
    expect(stdout).toContain('JARVIS daemon stopped.');
    expect(stdout).toContain(`Stopping JARVIS daemon (PID ${holder.pid})`);
    await holder.exited;
    expect(alive(holder.pid)).toBe(false);
    expect(existsSync(lockPath)).toBe(false);
  }, 60_000);

  test('stopDaemonGracefully stops it', async () => {
    const saved = process.env.JARVIS_HOME;
    const { jarvisHome, lockPath } = dataFolder('hardened-helper');
    const holder = await spawnHolder(jarvisHome, { harden: true });
    process.env.JARVIS_HOME = jarvisHome;
    try {
      const result = await stopDaemonGracefully({ timeoutMs: 5000, pollIntervalMs: 100 });
      expect(result).toEqual({ wasRunning: true, pid: holder.pid, graceful: true, stopped: true });
      await holder.exited;
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.JARVIS_HOME;
      else process.env.JARVIS_HOME = saved;
    }
  }, 60_000);
});

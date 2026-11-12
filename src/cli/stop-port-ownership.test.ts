import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { linkSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describeLeftAlone, ensurePortReleased, holdsJarvisLock, parsePidList, printableName, windowsListenerScript } from './lifecycle.ts';

/**
 * `jarvis stop` signals only the Jarvis daemon for this data folder.
 *
 * With no daemon holding the lock, `jarvis stop` still clears the port it
 * resolves (the lockfile's, else --port, JARVIS_PORT, daemon.port or 3142).
 * That cleanup used to SIGTERM and then SIGKILL every listener lsof or ss
 * reported on the port, so on a machine where something else used 3142 a plain
 * `jarvis stop` killed it.
 *
 * Every process signalled here is one this file spawned: a small Bun server on
 * a kernel-chosen loopback port (never a well-known one), optionally holding a
 * lock file inside this file's own temp folder open the way the daemon holds
 * its own. JARVIS_HOME and HOME point into that folder for the CLI case, so the
 * real ~/.jarvis is never read or written.
 */

const SANDBOX = mkdtempSync(join(tmpdir(), 'jarvis-stop-owner-'));
const PACKAGE_ROOT = join(import.meta.dir, '..', '..');

type Listener = { pid: number; port: number; exited: Promise<number>; kill: () => Promise<void> };
const spawned: Listener[] = [];

afterEach(async () => {
  for (const listener of spawned.splice(0)) await listener.kill();
});

afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true });
});

/**
 * A listener on 127.0.0.1:<kernel's pick>. With `lockPath`, it opens that file
 * and keeps the descriptor for its whole life, as acquireLock does in the
 * daemon; with `unlinkLock` it then deletes the file, leaving the descriptor on
 * a deleted inode. `onSigterm` makes it survive SIGTERM: 'ignore' keeps the
 * lock, 'drop-lock' closes it first.
 */
async function spawnListener(opts: { lockPath?: string; unlinkLock?: boolean; onSigterm?: 'ignore' | 'drop-lock'; prefix?: string[] } = {}): Promise<Listener> {
  const script = `
    const { openSync, closeSync, unlinkSync, constants } = require('node:fs');
    const lockPath = process.env.TEST_LOCK_PATH;
    let lockFd = null;
    if (lockPath) {
      lockFd = openSync(lockPath, constants.O_WRONLY | constants.O_CREAT, 0o644);
      if (process.env.TEST_UNLINK_LOCK === '1') unlinkSync(lockPath);
    }
    const onSigterm = process.env.TEST_ON_SIGTERM;
    if (onSigterm === 'ignore') process.on('SIGTERM', () => {});
    if (onSigterm === 'drop-lock') process.on('SIGTERM', () => { if (lockFd !== null) closeSync(lockFd); lockFd = null; });
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('ok') });
    console.log('BOUND:' + server.port);
    setInterval(() => {}, 1 << 30);
  `;
  const env: Record<string, string | undefined> = { ...process.env, TEST_LOCK_PATH: opts.lockPath, TEST_UNLINK_LOCK: opts.unlinkLock ? '1' : undefined, TEST_ON_SIGTERM: opts.onSigterm };
  const child = Bun.spawn([...(opts.prefix ?? []), process.execPath, '--eval', script], { env, stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' });
  const kill = async () => {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    await child.exited;
  };
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let seen = '';
  const deadline = Date.now() + 15_000;
  while (!seen.includes('\n') && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    seen += decoder.decode(value, { stream: true });
  }
  reader.releaseLock();
  const line = seen.split('\n').find((l) => l.startsWith('BOUND:'));
  if (!line) {
    await kill();
    throw new Error(`listener printed no BOUND line: ${JSON.stringify(seen)}`);
  }
  const listener = { pid: child.pid, port: Number(line.slice('BOUND:'.length)), exited: child.exited, kill };
  spawned.push(listener);
  return listener;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function dataFolder(name: string): { dir: string; lockPath: string } {
  const dir = join(SANDBOX, name);
  mkdirSync(dir, { recursive: true });
  return { dir, lockPath: join(dir, 'jarvis.pid') };
}

describe('ensurePortReleased', () => {
  test('leaves a listener that is not a Jarvis daemon running, and names it', async () => {
    const { lockPath } = dataFolder('plain');
    const other = await spawnListener();

    const result = await ensurePortReleased(other.port, { lockPath });

    // Found (so this is not passing because lsof/ss saw nothing) ...
    expect(result.leftAlone.map((l) => [l.pid, l.reason])).toEqual([[other.pid, 'not-jarvis']]);
    // ... and not touched.
    expect(alive(other.pid)).toBe(true);
    expect(result.terminated).toEqual([]);
    expect(result.forced).toEqual([]);
    expect(result.released).toBe(false);
    expect(result.leftAlone[0]!.command).toBeTruthy();
  }, 20_000);

  test('leaves alone a Jarvis daemon for a DIFFERENT data folder', async () => {
    const mine = dataFolder('mine');
    const theirs = dataFolder('theirs');
    const other = await spawnListener({ lockPath: theirs.lockPath });

    const result = await ensurePortReleased(other.port, { lockPath: mine.lockPath });

    expect(result.leftAlone.map((l) => l.pid)).toEqual([other.pid]);
    expect(alive(other.pid)).toBe(true);
  }, 20_000);

  test('stops a Jarvis daemon for this data folder that the lock no longer shows', async () => {
    const { lockPath } = dataFolder('stale');
    const daemon = await spawnListener({ lockPath });

    const result = await ensurePortReleased(daemon.port, { lockPath });

    expect(result.terminated).toEqual([daemon.pid]);
    expect(result.leftAlone).toEqual([]);
    expect(result.released).toBe(true);
    await daemon.exited;
  }, 20_000);

  test('SIGKILLs a Jarvis daemon for this data folder that ignores SIGTERM', async () => {
    const { lockPath } = dataFolder('stubborn');
    const daemon = await spawnListener({ lockPath, onSigterm: 'ignore' });

    const result = await ensurePortReleased(daemon.port, { lockPath });

    expect(result.forced).toEqual([daemon.pid]);
    expect(result.released).toBe(true);
    await daemon.exited;
  }, 20_000);

  test('does not SIGKILL a process that let go of the lock after SIGTERM', async () => {
    // What a reused pid would look like by the time SIGKILL is due: alive,
    // still on the port, and no longer holding this data folder's lock.
    const { lockPath } = dataFolder('let-go');
    const proc = await spawnListener({ lockPath, onSigterm: 'drop-lock' });

    const result = await ensurePortReleased(proc.port, { lockPath });

    expect(result.forced).toEqual([]);
    expect(result.leftAlone).toEqual([{ pid: proc.pid, command: expect.anything(), reason: 'let-go-of-lock' }]);
    expect(alive(proc.pid)).toBe(true);
  }, 20_000);

  // macOS lsof may or may not still name a deleted file; only Linux promises
  // the "<path> (deleted)" link this relies on.
  test.if(process.platform === 'linux')('stops it even after its lock file was deleted under it', async () => {
    const { lockPath } = dataFolder('deleted');
    const daemon = await spawnListener({ lockPath, unlinkLock: true });

    const result = await ensurePortReleased(daemon.port, { lockPath });

    expect(result.terminated).toEqual([daemon.pid]);
    expect(result.released).toBe(true);
    await daemon.exited;
  }, 20_000);
});

describe('holdsJarvisLock', () => {
  test('is true only for the process holding this lock file open', async () => {
    const { lockPath } = dataFolder('holds');
    const holder = await spawnListener({ lockPath });
    const stranger = await spawnListener();

    expect(await holdsJarvisLock(holder.pid, lockPath)).toBe(true);
    expect(await holdsJarvisLock(stranger.pid, lockPath)).toBe(false);
    // A file in the same folder with another name is not the lock.
    expect(await holdsJarvisLock(holder.pid, join(SANDBOX, 'holds', 'jarvis.pid.other'))).toBe(false);
  }, 20_000);

  test('knows the lock through a symlinked data folder, either way round', async () => {
    const { dir } = dataFolder('real-home');
    const link = join(SANDBOX, 'linked-home');
    symlinkSync(dir, link);
    const viaReal = await spawnListener({ lockPath: join(dir, 'jarvis.pid') });
    const viaLink = await spawnListener({ lockPath: join(link, 'jarvis.pid') });

    expect(await holdsJarvisLock(viaReal.pid, join(link, 'jarvis.pid'))).toBe(true);
    expect(await holdsJarvisLock(viaLink.pid, join(dir, 'jarvis.pid'))).toBe(true);
  }, 20_000);

  test('compares the file, not the path: a hard link to the lock is the lock', async () => {
    const { lockPath } = dataFolder('hard');
    const holder = await spawnListener({ lockPath });
    const alias = join(SANDBOX, 'hard', 'alias.pid');
    linkSync(lockPath, alias);
    expect(await holdsJarvisLock(holder.pid, alias)).toBe(true);
  }, 20_000);

  test('a file once at the lock path and since replaced by another is not this lock', async () => {
    // Renamed away, not deleted: the holder's file still exists under another
    // name, and a different file now sits at the lock path.
    const { lockPath } = dataFolder('replaced');
    const holder = await spawnListener({ lockPath });
    renameSync(lockPath, `${lockPath}.old`);
    writeFileSync(lockPath, '');
    expect(await holdsJarvisLock(holder.pid, lockPath)).toBe(false);
  }, 20_000);

  test.if(process.platform === 'linux')('a live file merely NAMED "jarvis.pid (deleted)" is not the lock', async () => {
    // /proc shows an unlinked file as "<path> (deleted)"; a file whose real
    // name ends that way reads the same and must not pass for one.
    const { lockPath } = dataFolder('spoof');
    const spoof = await spawnListener({ lockPath: `${lockPath} (deleted)` });
    expect(await holdsJarvisLock(spoof.pid, lockPath)).toBe(false);
    const result = await ensurePortReleased(spoof.port, { lockPath });
    expect(result.terminated).toEqual([]);
    expect(alive(spoof.pid)).toBe(true);
  }, 20_000);

  // Its own mount namespace, so "<path> (deleted)" names a path in a tree that
  // need not be ours. Needs unprivileged user namespaces (unshare -Urm); where
  // the host forbids them (some Ubuntu AppArmor profiles) this case is skipped,
  // and says so.
  test.if(process.platform === 'linux')('a deleted lock seen from another mount namespace is not this lock', async () => {
    const probe = Bun.spawnSync(['unshare', '-Urm', 'true'], { stdout: 'ignore', stderr: 'ignore' });
    if (probe.exitCode !== 0) {
      console.warn('skipped: unprivileged mount namespaces are not available here');
      return;
    }
    const { lockPath } = dataFolder('other-ns');
    const foreign = await spawnListener({ lockPath, unlinkLock: true, prefix: ['unshare', '-Urm'] });
    // Its /proc entry is readable from here and shows our path as deleted, so
    // the false below is the namespace check and not an unreadable fd list.
    const links = readdirSync(`/proc/${foreign.pid}/fd`).map((fd) => {
      try { return readlinkSync(`/proc/${foreign.pid}/fd/${fd}`); } catch { return ''; }
    });
    expect(links).toContain(`${join(realpathSync(dirname(lockPath)), 'jarvis.pid')} (deleted)`);
    expect(await holdsJarvisLock(foreign.pid, lockPath)).toBe(false);
    // Control: the same thing in OUR namespace is identified.
    const local = await spawnListener({ lockPath: join(SANDBOX, 'other-ns', 'b.pid'), unlinkLock: true });
    expect(await holdsJarvisLock(local.pid, join(SANDBOX, 'other-ns', 'b.pid'))).toBe(true);
  }, 20_000);

  // Records what macOS does with a lock deleted under its daemon, which the docs
  // do not promise: lsof may or may not still name the file. Either outcome is
  // safe; what must not happen is a crash or a stop of the wrong process.
  test.if(process.platform === 'darwin')('macOS: a deleted lock is either identified or safely left alone', async () => {
    const { lockPath } = dataFolder('darwin-deleted');
    const daemon = await spawnListener({ lockPath, unlinkLock: true });
    const result = await ensurePortReleased(daemon.port, { lockPath });
    console.warn(`macOS deleted-lock outcome: terminated=${JSON.stringify(result.terminated)} leftAlone=${JSON.stringify(result.leftAlone)}`);
    if (result.terminated.length > 0) expect(result.terminated).toEqual([daemon.pid]);
    else expect(result.leftAlone.map((l) => [l.pid, l.reason])).toEqual([[daemon.pid, 'not-jarvis']]);
  }, 20_000);

  test('is false for a pid that does not exist', async () => {
    const { lockPath } = dataFolder('gone');
    const gone = await spawnListener({ lockPath });
    await gone.kill();
    expect(await holdsJarvisLock(gone.pid, lockPath)).toBe(false);
  }, 20_000);
});

describe('finding the listeners', () => {
  // The child below runs ensurePortReleased with HOME pointing at a folder
  // whose login profile prints numbers. They must not be read as pids (they
  // used to be: lsof ran through `bash -lc`).
  test('does not read a login profile greeting as listeners', async () => {
    const home = dataFolder('noisy-home');
    // Above Linux's largest pid_max, so even a regression of both the parser
    // and the identity check could not signal anything real.
    writeFileSync(join(home.dir, '.bash_profile'), 'echo "Agent pid 4194305"\necho 4194305\n');
    writeFileSync(join(home.dir, '.profile'), 'echo 4194305\n');
    const other = await spawnListener();
    const lifecycle = new URL('./lifecycle.ts', import.meta.url).href;
    const script = `
      const { ensurePortReleased } = await import(${JSON.stringify(lifecycle)});
      const r = await ensurePortReleased(${other.port}, { lockPath: ${JSON.stringify(home.lockPath)} });
      console.log(JSON.stringify(r.leftAlone.map((l) => l.pid)));
    `;
    const env: Record<string, string | undefined> = { ...process.env, HOME: home.dir };
    for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
    const proc = Bun.spawn([process.execPath, '--eval', script], { env, cwd: home.dir, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(stderr).toBe('');
    expect(JSON.parse(stdout.trim())).toEqual([other.pid]);
    expect(alive(other.pid)).toBe(true);
  }, 30_000);
});

describe('Windows listener lookup', () => {
  test('puts one pid on each line, which is all parsePidList accepts', () => {
    // No -join: PowerShell already prints each pid on its own line, and a
    // `-join "\n"` there joins with a literal backslash-n (backtick escapes).
    expect(windowsListenerScript(4000)).not.toContain('-join');
    expect(windowsListenerScript(4000)).toMatch(/-ExpandProperty OwningProcess$/);
    // Two rows for one process (0.0.0.0 and ::), CRLF as PowerShell writes them.
    expect(parsePidList('1234\r\n1234\r\n5678\r\n', 1)).toEqual([1234, 5678]);
    expect(parsePidList('1234\\n1234', 1)).toEqual([]);
    expect(parsePidList('1234\n', 1234)).toEqual([]);
  });
});

describe('printableName', () => {
  test('replaces control characters so a process name cannot drive the terminal', () => {
    expect(printableName('python3')).toBe('python3');
    expect(printableName('evil\u001b]0;pwned\u0007\u009b2J')).toBe('evil?]0;pwned??2J');
  });
});

describe('describeLeftAlone', () => {
  test('names each listener and how to look it up on this platform', () => {
    expect(describeLeftAlone(4000, [])).toEqual([]);
    const lines = describeLeftAlone(4000, [
      { pid: 12, command: 'python3', reason: 'not-jarvis' },
      { pid: 13, command: null, reason: 'not-jarvis' },
      { pid: 14, command: 'bun', reason: 'let-go-of-lock' },
    ], 'darwin');
    expect(lines[0]).toContain('PID 12 (python3), PID 13,');
    expect(lines[0]).toContain('not the Jarvis daemon');
    expect(lines[0]).not.toContain('PID 14');
    // One that WAS signalled is not described as untouched.
    expect(lines[1]).toContain('PID 14 (bun)');
    expect(lines[1]).toContain('was asked to stop');
    expect(lines[2]).toBe('See what it is: lsof -nP -iTCP:4000 -sTCP:LISTEN');
    expect(describeLeftAlone(4000, [{ pid: 12, command: null, reason: 'no-permission' }], 'win32'))
      .toEqual([expect.stringContaining('may not signal'), 'See what it is: netstat -ano | findstr :4000']);
  });
});

describe('`jarvis stop` with no daemon running', () => {
  test('does not kill another program on the port it resolves', async () => {
    const home = dataFolder('cli-home');
    const jarvisHome = join(home.dir, '.jarvis');
    mkdirSync(jarvisHome, { recursive: true });
    const other = await spawnListener();

    const env: Record<string, string | undefined> = { ...process.env, HOME: home.dir, JARVIS_HOME: jarvisHome, JARVIS_PORT: undefined };
    for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
    const proc = Bun.spawn([process.execPath, join(PACKAGE_ROOT, 'bin', 'jarvis.ts'), 'stop', '--port', String(other.port)], {
      env,
      cwd: home.dir,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);

    expect(alive(other.pid)).toBe(true);
    expect(code).toBe(0);
    expect(stdout).toContain('JARVIS is not running.');
    expect(stdout).toContain(`PID ${other.pid}`);
    expect(stdout).toContain(`-iTCP:${other.port}`);
    expect(stderr).not.toContain('Error');
  }, 30_000);

  test('still stops a Jarvis daemon for this data folder that holds no visible lock', async () => {
    const home = dataFolder('cli-stale');
    const jarvisHome = join(home.dir, '.jarvis');
    mkdirSync(jarvisHome, { recursive: true });
    const lockPath = join(jarvisHome, 'jarvis.pid');
    const daemon = await spawnListener({ lockPath, unlinkLock: process.platform === 'linux' });
    // On macOS the file stays; it is unlocked (a plain open, no flock), which
    // is what `jarvis stop` sees when the daemon's flock is not visible.
    if (process.platform === 'linux') expect(() => unlinkSync(lockPath)).toThrow();

    const env: Record<string, string | undefined> = { ...process.env, HOME: home.dir, JARVIS_HOME: jarvisHome, JARVIS_PORT: undefined };
    for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
    const proc = Bun.spawn([process.execPath, join(PACKAGE_ROOT, 'bin', 'jarvis.ts'), 'stop', '--port', String(daemon.port)], {
      env,
      cwd: home.dir,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

    expect(code).toBe(0);
    expect(stdout).toContain(`Stopped the Jarvis daemon still listening on port ${daemon.port}: ${daemon.pid}`);
    await daemon.exited;
    expect(alive(daemon.pid)).toBe(false);
  }, 30_000);
});

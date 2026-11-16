import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  clearLaunchRecord,
  daemonStartFlags,
  detachedDaemonArgs,
  ensurePortReleased,
  isPortFree,
  isOwnJarvisCommand,
  parsePortArg,
  readLaunchRecord,
  restartStartArgs,
  writeLaunchRecord,
} from './lifecycle.ts';

const SANDBOX = mkdtempSync(join(tmpdir(), 'jarvis-cli-safety-'));
const ENTRY = join(import.meta.dir, '..', '..', 'bin', 'jarvis.ts');
let prevJarvisHome: string | undefined;
const children: Array<ReturnType<typeof Bun.spawn>> = [];

beforeAll(() => {
  prevJarvisHome = process.env.JARVIS_HOME;
  process.env.JARVIS_HOME = SANDBOX;
});

afterAll(() => {
  for (const child of children) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
  if (prevJarvisHome === undefined) delete process.env.JARVIS_HOME;
  else process.env.JARVIS_HOME = prevJarvisHome;
  try { rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** A listener that has nothing to do with Jarvis. Returns its pid and port. */
async function startUnrelatedListener(): Promise<{ pid: number; port: number }> {
  const child = Bun.spawn(
    ['bun', '-e', 'const s = Bun.serve({ port: 0, fetch: () => new Response("x") }); console.log(s.port); setInterval(() => {}, 1000);'],
    { stdout: 'pipe', stderr: 'ignore' },
  );
  children.push(child);
  const reader = child.stdout.getReader();
  const { value } = await reader.read();
  return { pid: child.pid, port: Number.parseInt(new TextDecoder().decode(value).trim(), 10) };
}

describe('ensurePortReleased leaves unrelated listeners alone', () => {
  test('an unrelated process on the port is reported, not signalled', async () => {
    const { pid, port } = await startUnrelatedListener();

    const result = await ensurePortReleased(port);

    expect(result.terminated).toEqual([]);
    expect(result.forced).toEqual([]);
    expect(result.foreign.map((f) => f.pid)).toEqual([pid]);
    expect(result.foreign[0]!.name).toBe('bun');
    expect(result.stuck).toEqual([]);
    expect(() => process.kill(pid, 0)).not.toThrow();
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(await res.text()).toBe('x');
  });

  test('a listener proven to be ours is still cleared', async () => {
    const { pid, port } = await startUnrelatedListener();

    const result = await ensurePortReleased(port, process.pid, async (p) => p === pid);

    expect(result.terminated.length + result.forced.length).toBe(1);
    expect(result.foreign).toEqual([]);
    expect(result.released).toBe(true);
  });
});

describe('ensurePortReleased before SIGKILL', () => {
  test('proves the pid is still ours again, so a pid reused during the wait is not killed', async () => {
    const child = Bun.spawn(
      ['bun', '-e', 'process.on("SIGTERM", () => {}); const s = Bun.serve({ port: 0, fetch: () => new Response("x") }); console.log(s.port); setInterval(() => {}, 1000);'],
      { stdout: 'pipe', stderr: 'ignore' },
    );
    children.push(child);
    const { value } = await child.stdout.getReader().read();
    const port = Number.parseInt(new TextDecoder().decode(value).trim(), 10);
    let asked = 0;

    // Ours when first looked at, someone else's by the time SIGTERM has been ignored.
    const result = await ensurePortReleased(port, process.pid, async (p) => p === child.pid && ++asked === 1);

    expect(asked).toBe(2);
    expect(result.forced).toEqual([]);
    expect(() => process.kill(child.pid, 0)).not.toThrow();
  }, 10_000);
});

describe('isOwnJarvisCommand', () => {
  test('matches this install by real path, including through a symlink', () => {
    const link = join(SANDBOX, 'bin-link', 'jarvis');
    mkdirSync(join(SANDBOX, 'bin-link'));
    symlinkSync(ENTRY, link);
    expect(isOwnJarvisCommand(['bun', ENTRY, 'start', '--no-open'])).toBe(true);
    expect(isOwnJarvisCommand(['bun', link, 'start'])).toBe(true);
  });

  test('does not match a program that only mentions jarvis', () => {
    expect(isOwnJarvisCommand(['node', 'server.js', '--name', 'jarvis'])).toBe(false);
    expect(isOwnJarvisCommand(['bun', '/somewhere/else/bin/jarvis.ts', 'start'])).toBe(false);
    expect(isOwnJarvisCommand([])).toBe(false);
  });
});

describe('parsePortArg', () => {
  test('accepts the space and equals forms', () => {
    expect(parsePortArg(['--port', '3196'])).toEqual({ port: 3196 });
    expect(parsePortArg(['-d', '--port=3196', '--no-open'])).toEqual({ port: 3196 });
    expect(parsePortArg(['-d'])).toEqual({ port: undefined });
  });

  test('a missing or unusable value is an error, never the default', () => {
    for (const args of [['--port'], ['--port', '--no-open'], ['--port='], ['--port=abc'], ['--port', '0'], ['--port=70000'], ['--port', '80x']]) {
      expect(parsePortArg(args)).toHaveProperty('error');
    }
  });
});

describe('restart keeps how the daemon was started', () => {
  test('the launch record round-trips and belongs to one pid', () => {
    writeLaunchRecord({ pid: 4242, detached: true, noOpen: true, noLocalTools: false, port: 3195 });
    expect(readLaunchRecord(4242)).toMatchObject({ pid: 4242, detached: true, noOpen: true, port: 3195 });
    expect(readLaunchRecord(4243)).toBeNull();
    clearLaunchRecord();
    expect(readLaunchRecord(4242)).toBeNull();
  });

  test('a detached daemon on a custom port restarts detached on that port', () => {
    const record = { pid: 1, detached: true, noOpen: true, noLocalTools: true, port: 3195, dataDir: '/d', systemConfigPath: '/etc/j.yaml' };
    expect(restartStartArgs(record, [])).toEqual([
      '--detach', '--no-open', '--no-local-tools', '--port', '3195', '--data-dir', '/d', '--system-config', '/etc/j.yaml',
    ]);
  });

  test('options the user passes now win over the recorded ones', () => {
    const record = { pid: 1, detached: true, noOpen: false, noLocalTools: false, port: 3195 };
    expect(restartStartArgs(record, ['--port=4000'])).toEqual(['--port=4000', '--detach']);
    expect(restartStartArgs(record, ['-d', '--port', '4000'])).toEqual(['-d', '--port', '4000']);
  });

  test('with no record the arguments are passed through unchanged', () => {
    expect(restartStartArgs(null, ['--port', '9'])).toEqual(['--port', '9']);
  });
});

describe('the launch record is only trusted when it is ours', () => {
  const recordPath = () => join(SANDBOX, 'jarvis.launch.json');
  const plant = (record: unknown, mode = 0o600) => {
    rmSync(recordPath(), { force: true });
    writeFileSync(recordPath(), JSON.stringify(record), { mode });
    chmodSync(recordPath(), mode); // whatever the umask
  };

  test('is written beside the lock, 0600, and read back for its pid', () => {
    clearLaunchRecord();
    writeLaunchRecord({ pid: 100, detached: false, noOpen: false, noLocalTools: true, port: 4100, dataDir: '/srv/jarvis' });
    expect(statSync(recordPath()).mode & 0o777).toBe(0o600);
    expect(readLaunchRecord(100)).toMatchObject({ noLocalTools: true, port: 4100, dataDir: '/srv/jarvis' });
  });

  test('stores relative paths as the absolute paths the daemon used', () => {
    writeLaunchRecord({ pid: 100, detached: false, noOpen: false, noLocalTools: false, dataDir: 'rel/data', systemConfigPath: 'rel/system.yaml' });
    expect(readLaunchRecord(100)).toMatchObject({ dataDir: resolve('rel/data'), systemConfigPath: resolve('rel/system.yaml') });
  });

  test('is 0600 even when it replaces a looser file, and never writes through a symlink', () => {
    plant({}, 0o644);
    writeLaunchRecord({ pid: 100, detached: false, noOpen: false, noLocalTools: false, port: 4100 });
    expect(statSync(recordPath()).mode & 0o777).toBe(0o600);

    rmSync(recordPath());
    const target = join(SANDBOX, 'elsewhere.txt');
    writeFileSync(target, 'untouched');
    symlinkSync(target, recordPath());
    writeLaunchRecord({ pid: 100, detached: false, noOpen: false, noLocalTools: false, port: 4100 });
    expect(readFileSync(target, 'utf-8')).toBe('untouched');
    expect(lstatSync(recordPath()).isSymbolicLink()).toBe(false);
    expect(readLaunchRecord(100)).toMatchObject({ port: 4100 });
    expect(existsSync(`${recordPath()}.${process.pid}.tmp`)).toBe(false);
  });

  test('ignores a record others can write, or one that is a symlink', () => {
    writeLaunchRecord({ pid: 100, detached: false, noOpen: false, noLocalTools: false, port: 4100 });
    chmodSync(recordPath(), 0o666);
    expect(readLaunchRecord(100)).toBeNull();
    chmodSync(recordPath(), 0o620);
    expect(readLaunchRecord(100)).toBeNull();

    rmSync(recordPath());
    const planted = join(SANDBOX, 'planted.json');
    writeFileSync(planted, JSON.stringify({ pid: 100, detached: false, noOpen: false, noLocalTools: false, port: 4100 }), { mode: 0o600 });
    symlinkSync(planted, recordPath());
    expect(readLaunchRecord(100)).toBeNull();
    rmSync(recordPath());
  });

  test('drops a relative, dash-leading or NUL-carrying path from a hand-edited record', () => {
    plant({ pid: 100, detached: false, noOpen: false, noLocalTools: false, port: 4100, dataDir: 'relative/data', systemConfigPath: '/etc/j\u0000.yaml' });
    expect(readLaunchRecord(100)).toMatchObject({ port: 4100, dataDir: undefined, systemConfigPath: undefined });
    plant({ pid: 100, detached: false, noOpen: false, noLocalTools: false, dataDir: '-d', systemConfigPath: '--no-open' });
    const record = readLaunchRecord(100);
    expect(record).toMatchObject({ dataDir: undefined, systemConfigPath: undefined });
    expect(restartStartArgs(record, [])).toEqual([]);
  });

  test('reads nothing when there is no record or it is not JSON', () => {
    clearLaunchRecord();
    expect(readLaunchRecord(100)).toBeNull();
    rmSync(recordPath(), { force: true });
    writeFileSync(recordPath(), 'not json', { mode: 0o600 });
    expect(readLaunchRecord(100)).toBeNull();
    clearLaunchRecord();
  });
});

describe('restart says which recorded options it reused', () => {
  test('the user\'s arguments come first, so the tail is what came from the record', () => {
    const record = { pid: 1, detached: false, noOpen: false, noLocalTools: true, port: 4100, dataDir: '/srv/jarvis' };
    const args = ['-d'];
    const startArgs = restartStartArgs(record, args);
    expect(startArgs.slice(0, args.length)).toEqual(args);
    expect(startArgs.slice(args.length)).toEqual(['--no-local-tools', '--port', '4100', '--data-dir', '/srv/jarvis']);
  });

  // cmdRestart cannot be driven here without a real daemon, so the order and
  // the note are pinned at the source.
  test('reads the record before the stop, prints the note, and starts with the merged args', () => {
    const source = readFileSync(ENTRY, 'utf-8');
    const restart = source.slice(source.indexOf('async function cmdRestart'));
    const read = restart.indexOf('readLaunchRecord(pid)');
    expect(read).toBeGreaterThan(-1);
    expect(read).toBeLessThan(restart.indexOf('await cmdStop()'));
    expect(restart).toContain('Starting with the options it was started with: ${reused.join(\' \')}');
    expect(restart.indexOf('Starting with the options')).toBeLessThan(restart.indexOf('await cmdStart(startArgs);'));
  });
});

describe('daemonStartFlags', () => {
  test('forwards every option that changes what the daemon does', () => {
    expect(daemonStartFlags({ port: 8080, dataDir: '/srv/jarvis', noLocalTools: true, systemConfigPath: '/etc/j.yaml' }))
      .toEqual(['--port', '8080', '--data-dir', '/srv/jarvis', '--no-local-tools', '--system-config', '/etc/j.yaml']);
  });

  test('is empty with no options', () => {
    expect(daemonStartFlags({ noLocalTools: false })).toEqual([]);
  });
});

describe('isOwnJarvisCommand with a relative path', () => {
  test('is read from the process directory, not ours', () => {
    expect(isOwnJarvisCommand(['bun', '--no-env-file', 'run', 'bin/jarvis.ts', 'start'], ENTRY, join(ENTRY, '..', '..'))).toBe(true);
    expect(isOwnJarvisCommand(['bun', 'run', 'bin/jarvis.ts', 'start'], ENTRY, SANDBOX)).toBe(false);
  });
});

describe('start -d hands its child every option', () => {
  test('--no-local-tools, --data-dir, --port and --system-config reach the detached daemon', () => {
    expect(detachedDaemonArgs('/x/bin/jarvis.ts', {
      port: 3195, dataDir: '/d', noLocalTools: true, systemConfigPath: '/etc/j.yaml',
    })).toEqual([
      '/x/bin/jarvis.ts', 'start', '--no-open', '--port', '3195', '--data-dir', '/d', '--no-local-tools', '--system-config', '/etc/j.yaml',
    ]);
    expect(detachedDaemonArgs('/x/bin/jarvis.ts', { noLocalTools: false })).toEqual(['/x/bin/jarvis.ts', 'start', '--no-open']);
  });
});

describe('isPortFree', () => {
  test('a port held on 0.0.0.0 is busy; a free one is free', async () => {
    const { port } = await startUnrelatedListener();
    expect(await isPortFree(port)).toBe(false);
    const probe = Bun.serve({ port: 0, fetch: () => new Response('') });
    const freed = probe.port!;
    probe.stop(true);
    expect(await isPortFree(freed)).toBe(true);
  });

  test('a listener on ::1 only does not block the 0.0.0.0 bind the daemon makes', async () => {
    let held: ReturnType<typeof Bun.serve>;
    try { held = Bun.serve({ hostname: '::1', port: 0, fetch: () => new Response('') }); } catch { return; /* no IPv6 here */ }
    try {
      expect(await isPortFree(held.port!)).toBe(true);
    } finally {
      held.stop(true);
    }
  });
});

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearLaunchRecord,
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

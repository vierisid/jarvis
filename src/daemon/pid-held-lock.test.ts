import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

// In the shipped Docker image the daemon is the container's pid 1 (ENTRYPOINT
// ["jarvis"], no init), so its lock file says "1". The lock probe used to treat
// "pid 1 inside a container" as a lock left over from an earlier container and
// unlink it, even though the probe had just failed to take the flock, i.e. a
// live process held it. Then `docker exec <c> jarvis status` said "stopped",
// deleted the running daemon's lock, and let a second daemon lock a fresh file
// on the same data folder.
//
// The test runs in its own `bun test` process because it has to look like a
// container (`/.dockerenv` present) to the code under test, and mock.module
// on node:fs would otherwise leak into every other test file in this run.

const PID_MODULE = join(import.meta.dir, 'pid.ts');

let WORK: string;

beforeAll(() => {
  WORK = mkdtempSync(join(tmpdir(), 'jarvis-held-lock-'));
});

afterAll(() => {
  rmSync(WORK, { recursive: true, force: true });
});

function fixture(body: string): string {
  return `
import { test, expect, mock } from 'bun:test';
import * as realFs from 'node:fs';

// Look like a container: /.dockerenv exists. Everything else is the real fs.
const real = { ...realFs };
const existsSync = (p: unknown) => p === '/.dockerenv' ? true : real.existsSync(p as string);
mock.module('node:fs', () => ({ ...real, existsSync, default: { ...(real as any).default, existsSync } }));

const fs = await import('node:fs');
const pid = await import(${JSON.stringify(PID_MODULE)});
const lockPath = pid.getPidPath();

test('the fake container is in effect', () => {
  expect(fs.existsSync('/.dockerenv')).toBe(true);
  expect(lockPath).toBe(${JSON.stringify('__HOME__')} + '/jarvis.pid');
});

${body}
`;
}

async function runFixture(name: string, body: string): Promise<void> {
  const home = mkdtempSync(join(WORK, `${name}-`));
  const file = join(WORK, `${name}.fixture.ts`);
  writeFileSync(file, fixture(body).replace('__HOME__', home));
  const proc = Bun.spawn([process.execPath, 'test', file], {
    cwd: WORK,
    env: { ...process.env, JARVIS_HOME: home, HOME: home },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, out, err] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`fixture ${name} failed (exit ${code})\n${out}\n${err}`);
}

describe('a held lock is never stale', () => {
  test('a daemon that is pid 1 in a container is reported running, and its lock is kept', async () => {
    await runFixture('held-pid1', `
test('held by pid 1', () => {
  // Stands in for the container's daemon: it holds the flock and wrote "1".
  const holder = pid.acquireLockAt(lockPath, 1);
  expect(holder).not.toBeNull();
  try {
    const before = fs.statSync(lockPath).ino;

    // What \`jarvis status\` and \`jarvis stop\` ask first.
    expect(pid.isLocked()).toBe(1);
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(fs.statSync(lockPath).ino).toBe(before);

    // And a second daemon on the same data folder is refused.
    expect(pid.acquireLock(4242)).toBe(false);
    expect(fs.readFileSync(lockPath, 'utf-8')).toBe('1');
  } finally {
    holder!.release();
  }
});
`);
  }, 30_000);

  test('a pid-1 lock nobody holds still reads as stopped and can be taken over', async () => {
    await runFixture('stale-pid1', `
test('stale pid 1', () => {
  fs.writeFileSync(lockPath, '1\\n3142\\n');
  expect(pid.isLocked()).toBeNull();
  expect(pid.acquireLock(4242)).toBe(true);
  try {
    expect(fs.readFileSync(lockPath, 'utf-8')).toBe('4242');
  } finally {
    pid.releaseLock();
  }
});
`);
  }, 30_000);
});

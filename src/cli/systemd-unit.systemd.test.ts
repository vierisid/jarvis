/**
 * #525 against a REAL systemd user manager: `jarvis restart` and `jarvis
 * update` run from INSIDE the unit's cgroup, where the assistant's run_command
 * runs them, must leave Jarvis running under the unit.
 *
 * The unit is the text generateSystemdUnit() writes (Restart=on-failure,
 * default KillMode) with ExecStart swapped for a stand-in daemon that takes the
 * real lock and, like the daemon's drain, exits 0 on SIGTERM. Without the fix
 * the CLI stops it, on-failure leaves it stopped, and systemd kills the CLI
 * with the rest of the cgroup, so neither the CLI's report nor the unit's
 * return ever comes.
 *
 * Skipped wherever that cannot be set up: no reachable `systemctl --user` or
 * no systemd-run (containers, most CI runners, macOS), or a test process that
 * is not itself under the user manager (an ssh session scope), which the
 * kernel will not let into a user unit's cgroup. Units are linked under a
 * unique per-run name with `--runtime` (the link lives in /run and dies with
 * the session even if this run is killed before afterAll) and removed
 * afterwards; each stand-in exits by itself after a few minutes. The real
 * `jarvis.service` is never touched.
 */
import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { generateSystemdUnit } from './autostart.ts';
import { parseCgroupPath } from './systemd-unit.ts';
import { isLocked, lockPathFor } from '../daemon/pid.ts';

const REPO = join(import.meta.dir, '..', '..');
const PID_MODULE = join(REPO, 'src', 'daemon', 'pid.ts');
const UPDATE_MODULE = join(REPO, 'src', 'cli', 'update.ts');
// The random part keeps a pid reused from a crashed run off its leftover link.
const UNIT_PREFIX = `jarvis-itest-${process.pid}-${randomBytes(3).toString('hex')}`;

function sh(cmd: string[], env?: Record<string, string | undefined>): { code: number | null; out: string } {
  const r = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'pipe', env: env ?? { ...process.env }, timeout: 60_000 });
  return { code: r.exitCode, out: `${r.stdout.toString()}${r.stderr.toString()}`.trim() };
}

/** Our own user manager's cgroup, if this process runs under it and may move processes within it. */
function userManagerCgroup(): string | null {
  if (process.platform !== 'linux' || !existsSync('/sys/fs/cgroup/cgroup.controllers')) return null;
  const uid = process.getuid?.();
  let self: string | null = null;
  try { self = parseCgroupPath(readFileSync('/proc/self/cgroup', 'utf-8')); } catch { return null; }
  const marker = `/user@${uid}.service/`;
  const at = self?.indexOf(marker) ?? -1;
  if (!self || at === -1) return null;
  const manager = self.slice(0, at + marker.length - 1);
  try {
    accessSync(`/sys/fs/cgroup${manager}/cgroup.procs`, constants.W_OK);
    return manager;
  } catch {
    return null;
  }
}

function systemdUsable(): boolean {
  if (!Bun.which('systemctl') || !Bun.which('systemd-run')) return false;
  if (userManagerCgroup() === null) return false;
  return sh(['systemctl', '--user', 'is-system-running']).code === 0
    || sh(['systemctl', '--user', 'show-environment']).code === 0;
}

const ENABLED = process.platform === 'linux' && systemdUsable();

let DATA_DIR: string;
let prevJarvisHome: string | undefined;
const linkedUnits: string[] = [];
const homes: string[] = [];

function unitState(name: string): { state: string; pid: number } {
  const out = sh(['systemctl', '--user', 'show', `${name}.service`, '--property=ActiveState', '--property=MainPID']).out;
  const state = /ActiveState=(\S+)/.exec(out)?.[1] ?? 'unknown';
  const pid = Number(/MainPID=(\d+)/.exec(out)?.[1] ?? 0);
  return { state, pid };
}

function loadedUnits(pattern: string): string[] {
  return sh(['systemctl', '--user', 'list-units', pattern, '--all', '--no-legend', '--plain'])
    .out.split('\n').map((l) => l.trim()).filter(Boolean);
}

async function waitFor<T>(what: string, probe: () => T | null, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = probe();
    if (value !== null) return value;
    await Bun.sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * Link + start a unit made from the generated text, with its own data root;
 * returns the stand-in's pid once it holds the lock.
 */
async function startStandInUnit(name: string): Promise<number> {
  const home = join(DATA_DIR, name.replace(/\\/g, '_'));
  mkdirSync(home, { recursive: true });
  homes.push(home);
  process.env.JARVIS_HOME = home;
  const standIn = join(home, 'stand-in.ts');
  // JARVIS_HOME is set in here as well as by the unit, so the stand-in can
  // never reach for the real ~/.jarvis lock.
  writeFileSync(standIn, `
process.env.JARVIS_HOME = ${JSON.stringify(home)};
const { acquireLock } = await import(${JSON.stringify(PID_MODULE)});
// The real daemon drains on SIGTERM and exits 0: the clean exit that
// Restart=on-failure does not restart. The timeout is the same clean exit,
// so a run killed before afterAll leaves nothing running for long.
process.on('SIGTERM', () => process.exit(0));
setTimeout(() => process.exit(0), 180_000);
while (!acquireLock(process.pid)) await Bun.sleep(20);
`, 'utf-8');

  const generated = generateSystemdUnit();
  expect(generated).toContain('Restart=on-failure');
  expect(generated).toContain(`Environment="JARVIS_HOME=${home}"`);
  const body = generated.replace(/^ExecStart=.*$/m, `ExecStart=${process.execPath} ${standIn}`);
  const unitPath = join(home, `${name}.service`);
  writeFileSync(unitPath, body, 'utf-8');

  const link = sh(['systemctl', '--user', 'link', '--runtime', unitPath]);
  if (link.code !== 0) throw new Error(`systemctl link failed: ${link.out}`);
  linkedUnits.push(name);
  const start = sh(['systemctl', '--user', 'start', `${name}.service`]);
  if (start.code !== 0) throw new Error(`systemctl start failed: ${start.out}`);

  return waitFor('the stand-in to take the lock', () => {
    const { state, pid } = unitState(name);
    return state === 'active' && pid > 0 && isLocked() === pid ? pid : null;
  }, 30_000);
}

/** Run argv as a process moved into the unit's cgroup first, as run_command's children are. */
function runInsideUnit(name: string, argv: string[]): { code: number | null; out: string } {
  const cgroup = sh(['systemctl', '--user', 'show', `${name}.service`, '--property=ControlGroup', '--value']).out;
  expect(cgroup).toContain(`/${name}.service`);
  return sh(
    ['bash', '-c', 'echo $$ > "$0" && exec "$@"', `/sys/fs/cgroup${cgroup}/cgroup.procs`, ...argv],
    { ...process.env },
  );
}

/** The unit came back with a new main process that holds the lock. */
async function expectBackUnderUnit(name: string, oldPid: number): Promise<void> {
  const pid = await waitFor(`${name} to come back`, () => {
    const now = unitState(name);
    return now.state === 'active' && now.pid > 0 && now.pid !== oldPid && isLocked() === now.pid ? now.pid : null;
  }, 30_000).catch((err) => {
    throw new Error(`${(err as Error).message}; unit is ${JSON.stringify(unitState(name))}`);
  });
  expect(pid).not.toBe(oldPid);
  // Started by the unit itself, so with the unit's own environment: not
  // spawned by the CLI or the transient updater, whose environment could lack
  // what the unit's Environment= carries (the workflow key, #514).
  expect(parseCgroupPath(readFileSync(`/proc/${pid}/cgroup`, 'utf-8'))).toEndWith(`/${name}.service`);
  const environ = readFileSync(`/proc/${pid}/environ`, 'utf-8').split('\0');
  expect(environ.some((e) => e.startsWith('JARVIS_UPDATE_UNIT='))).toBe(false);
  expect(environ).toContain(`JARVIS_HOME=${process.env.JARVIS_HOME}`);
}

describe.skipIf(!ENABLED)('restart and update from inside a real systemd user unit (#525)', () => {
  beforeAll(() => {
    prevJarvisHome = process.env.JARVIS_HOME;
    DATA_DIR = mkdtempSync(join(tmpdir(), 'jarvis-restart-itest-'));
  });

  afterAll(() => {
    // Transient restart/update units too, should a test have died mid-way.
    sh(['systemctl', '--user', 'stop', `${UNIT_PREFIX}-*`]);
    for (const name of linkedUnits) sh(['systemctl', '--user', 'disable', '--runtime', `${name}.service`]);
    sh(['systemctl', '--user', 'daemon-reload']);
    sh(['systemctl', '--user', 'reset-failed', `${UNIT_PREFIX}-*`]);
    // A daemon the CLI started outside its unit (the pre-#525 restart path)
    // holds the lock of one of our homes: stop it too.
    for (const home of homes) {
      const stray = isLocked(lockPathFor(home));
      if (stray) try { process.kill(stray, 'SIGKILL'); } catch { /* gone */ }
    }
    if (prevJarvisHome === undefined) delete process.env.JARVIS_HOME;
    else process.env.JARVIS_HOME = prevJarvisHome;
    try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('jarvis restart schedules the restart with systemd and the daemon comes back under the unit', async () => {
    const name = `${UNIT_PREFIX}-cli`;
    const oldPid = await startStandInUnit(name);

    const cli = runInsideUnit(name, [process.execPath, join(REPO, 'bin', 'jarvis.ts'), 'restart']);
    expect(cli.out).toContain('Restart scheduled');
    expect(cli.code).toBe(0);

    await expectBackUnderUnit(name, oldPid);
    // The transient timer and its service are collected once they ran.
    await waitFor('the transient restart units to go', () => (loadedUnits(`${name}-restart*`).length === 0 ? true : null), 10_000);
  }, 90_000);

  test('jarvis restart from a terminal goes through systemd, and its arguments are ignored', async () => {
    const name = `${UNIT_PREFIX}-term`;
    const oldPid = await startStandInUnit(name);
    const home = process.env.JARVIS_HOME!;

    // -d, --no-open and HOME keep the pre-#525 path contained if the routing
    // is ever lost: a detached daemon in this test's home, reaped in afterAll.
    const cli = sh(
      [process.execPath, join(REPO, 'bin', 'jarvis.ts'), 'restart', '-d', '--no-open', '--port', String(40000 + (process.pid % 20000))],
      { ...process.env, HOME: home },
    );
    expect(cli.out).toContain('Restarting JARVIS through systemd');
    expect(cli.out).toContain('Ignoring -d --no-open --port');
    expect(cli.code).toBe(0);

    await expectBackUnderUnit(name, oldPid);
  }, 90_000);

  /**
   * A package root whose bin/jarvis.ts is the updater the transient unit runs:
   * the real runUpdate with the install step stubbed to record what it saw
   * (nothing is installed), plus a driver: the `jarvis update` a user or the
   * assistant runs, whose install step must never be reached.
   */
  function writeUpdater(
    home: string,
    opts: { hangAfterInstall?: boolean; runtimeMaxSec?: number } = {},
  ): { driver: string; marker: string } {
    const root = join(home, 'pkg');
    const marker = join(home, 'installed.json');
    mkdirSync(join(root, 'bin'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@usejarvis/brain', version: '1.0.0' }), 'utf-8');
    const stub = (installStep: string) => `
import { writeFileSync } from 'node:fs';
import { runUpdate } from ${JSON.stringify(UPDATE_MODULE)};
import { isLocked } from ${JSON.stringify(PID_MODULE)};
const result = await runUpdate({
  packageRoot: ${JSON.stringify(root)},
  detect: () => ({ method: 'bun-global', reason: 'integration test' }),
  spawn: (cmd) => { ${installStep} return { exitCode: 0, stdout: 'installed', stderr: '' }; },
  systemdWait: { followMs: 60_000, follow: true${opts.runtimeMaxSec ? `, runtimeMaxSec: ${opts.runtimeMaxSec}` : ''} },
});
console.log('RESULT ' + JSON.stringify(result));
process.exit(result.exitCode);
`;
    writeFileSync(join(root, 'bin', 'jarvis.ts'), stub(
      `writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ cmd, lockHolder: isLocked() }));`
        + (opts.hangAfterInstall ? ' Bun.sleepSync(120_000);' : ''),
    ), 'utf-8');
    const driver = join(home, 'driver.ts');
    writeFileSync(driver, stub(`throw new Error('installed by the CLI itself');`), 'utf-8');
    return { driver, marker };
  }

  async function expectInstalledWhileStopped(marker: string): Promise<void> {
    const installed = await waitFor('the update to install', () => (existsSync(marker) ? readFileSync(marker, 'utf-8') : null), 60_000);
    // Installed by the transient updater while the daemon was stopped.
    expect(JSON.parse(installed)).toEqual({ cmd: ['bun', 'update', '-g', '@usejarvis/brain'], lockHolder: null });
  }

  test('jarvis update from inside the unit hands off to a transient updater: stop, update, start', async () => {
    const name = `${UNIT_PREFIX}-upd`;
    const oldPid = await startStandInUnit(name);
    const { driver, marker } = writeUpdater(process.env.JARVIS_HOME!);

    const cli = runInsideUnit(name, [process.execPath, driver]);
    expect(cli.out).toContain('"outcome":"delegated"');
    expect(cli.code).toBe(0);

    await expectInstalledWhileStopped(marker);
    await expectBackUnderUnit(name, oldPid);
    await waitFor('the transient update unit to go', () => (loadedUnits(`${name}-update*`).length === 0 ? true : null), 30_000);
  }, 120_000);

  test('jarvis update from a terminal runs the same updater and follows it to the end', async () => {
    const name = `${UNIT_PREFIX}-updterm`;
    const oldPid = await startStandInUnit(name);
    const { driver, marker } = writeUpdater(process.env.JARVIS_HOME!);

    const cli = sh([process.execPath, driver]);
    expect(cli.out).toContain('"outcome":"delegated"');
    expect(cli.code).toBe(0);

    // Followed to the end: all done by the time the CLI returned.
    await expectInstalledWhileStopped(marker);
    await expectBackUnderUnit(name, oldPid);
    expect(loadedUnits(`${name}-update*`)).toEqual([]);
  }, 120_000);

  test('an updater killed between stop and start still leaves the unit running', async () => {
    const name = `${UNIT_PREFIX}-updkill`;
    const oldPid = await startStandInUnit(name);
    const { driver, marker } = writeUpdater(process.env.JARVIS_HOME!, { hangAfterInstall: true });

    const cli = runInsideUnit(name, [process.execPath, driver]);
    expect(cli.code).toBe(0);
    await expectInstalledWhileStopped(marker);
    expect(unitState(name).state).toBe('inactive');

    // The updater dies (a crash, the OOM killer) before it could start the unit again.
    process.kill(unitState(`${name}-update`).pid, 'SIGKILL');
    await expectBackUnderUnit(name, oldPid);
    sh(['systemctl', '--user', 'reset-failed', `${name}-update.service`]);
  }, 120_000);

  test('a hung updater is stopped by its RuntimeMaxSec and the unit, escaped name and all, comes back', async () => {
    // `\x2d` in the name: ExecStopPost must start this unit, not `...-hang-x`.
    const name = `${UNIT_PREFIX}-hang\\x2dx`;
    const updater = `${UNIT_PREFIX}-hang-x2dx-update`;
    const oldPid = await startStandInUnit(name);
    const { driver, marker } = writeUpdater(process.env.JARVIS_HOME!, { hangAfterInstall: true, runtimeMaxSec: 6 });

    const cli = runInsideUnit(name, [process.execPath, driver]);
    expect(cli.code).toBe(0);
    await expectInstalledWhileStopped(marker);

    await expectBackUnderUnit(name, oldPid);
    expect(sh(['systemctl', '--user', 'show', `${updater}.service`, '--property=Result']).out).toBe('Result=timeout');
    sh(['systemctl', '--user', 'reset-failed', `${updater}.service`]);
  }, 120_000);
});

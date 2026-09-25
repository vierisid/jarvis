/**
 * #525: detection of a daemon that is a systemd user unit's main process, and
 * the commands `jarvis restart` / `jarvis update` send systemd for it.
 *
 * systemctl and systemd-run are fakes on PATH that record their argv and
 * answer from files, so nothing here reaches a real user manager. The unit
 * name is made up as well: if PATH were ever ignored, the real systemctl would
 * fail to find it, and a real systemd-run would only create short-lived
 * transient units that fail and are collected.
 * src/cli/systemd-unit.systemd.test.ts runs the same
 * paths against a real user manager.
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detectSystemdUnit,
  parseCgroupPath,
  restartSystemdUnit,
  runCommand,
  userUnitFromCgroup,
  SCHEDULE_DELAY_SEC,
  UPDATE_ENV,
  type SystemdUnit,
} from './systemd-unit.ts';
import { runUpdate, type SpawnResult } from './update.ts';
import type { StopResult } from './daemon-control.ts';

const PID_MODULE = join(import.meta.dir, '..', 'daemon', 'pid.ts');
const UID = 1000;
const UNIT = `jarvis-fake-${process.pid}.service`;
const STEM = `jarvis-fake-${process.pid}`;
const MANAGER = `/user.slice/user-${UID}.slice/user@${UID}.service`;
const UNIT_CGROUP = `${MANAGER}/app.slice/${UNIT}`;
const TERMINAL_CGROUP = `${MANAGER}/app.slice/app-kitty-1234.scope`;

let fakeDir: string;
let prevPath: string | undefined;
let prevJarvisHome: string | undefined;
let holder: ReturnType<typeof Bun.spawn> | null = null;

// One script serves as all three binaries. Each call appends its argv,
// separated by \x1f, as one line of calls.log. `systemctl show <unit>` prints
// the file `state.<unit>` (else `state`) when asked for ActiveState, else
// `MainPID=` from the file `mainpid` and `Transient=` from `transient`. Exit
// codes come from `<binary>.<subcommand>.exit`, then `<binary>.exit`
// (default 0); stderr from `<binary>.stderr`. journalctl prints nothing.
const FAKE = `#!/bin/sh
dir=$(dirname "$0")
name=$(basename "$0")
{ printf '%s\\037' "$name" "$@"; printf '\\n'; } >> "$dir/calls.log"
sub=
unit=
for a in "$@"; do case "$a" in -*) ;; *) if [ -z "$sub" ]; then sub=$a; elif [ -z "$unit" ]; then unit=$a; fi ;; esac; done
code=0
if [ -f "$dir/$name.$sub.exit" ]; then code=$(cat "$dir/$name.$sub.exit")
elif [ -f "$dir/$name.exit" ]; then code=$(cat "$dir/$name.exit"); fi
[ -f "$dir/$name.stderr" ] && cat "$dir/$name.stderr" >&2
if [ "$name" = systemctl ] && [ "$sub" = show ]; then
  case " $* " in
    *"--property=ActiveState"*)
      if [ -f "$dir/state.$unit" ]; then cat "$dir/state.$unit"; elif [ -f "$dir/state" ]; then cat "$dir/state"; fi ;;
    *)
      [ -f "$dir/mainpid" ] && printf 'MainPID=%s\\n' "$(cat "$dir/mainpid")"
      printf 'Transient=%s\\n' "$(cat "$dir/transient" 2>/dev/null || echo no)" ;;
  esac
fi
exit "$code"
`;

function calls(): string[][] {
  const log = join(fakeDir, 'calls.log');
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\x1f').slice(0, -1));
}

/** Run `fn` with env vars set, restoring whatever was there before. */
async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function setFile(name: string, content: string): void {
  writeFileSync(join(fakeDir, name), content, 'utf-8');
}

function cgroups(map: Record<string, string>): (pid: number | 'self') => string | null {
  return (pid) => {
    const path = map[String(pid)];
    return path === undefined ? null : `0::${path}\n`;
  };
}

/** Tests that start a lock holder: a cold bun start is slow on a loaded machine. */
const LOCK_HOLDER_TIMEOUT = 30_000;

/** A real process holding the daemon lock under JARVIS_HOME=fakeDir: systemd's "new daemon". */
async function spawnLockHolder(): Promise<number> {
  const ready = join(fakeDir, 'holder-ready');
  const script = join(fakeDir, 'holder.ts');
  writeFileSync(script, `
import { acquireLock } from ${JSON.stringify(PID_MODULE)};
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(ready)}, acquireLock(process.pid) ? String(process.pid) : 'FAIL');
await Bun.sleep(60000);
`, 'utf-8');
  holder = Bun.spawn([process.execPath, script], { stdio: ['ignore', 'ignore', 'ignore'], env: { ...process.env, JARVIS_HOME: fakeDir } });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await Bun.sleep(25);
    if (!existsSync(ready)) continue;
    const content = readFileSync(ready, 'utf-8').trim();
    unlinkSync(ready);
    if (content === 'FAIL') throw new Error('lock holder could not take the lock');
    return Number(content);
  }
  throw new Error('lock holder never started');
}

beforeEach(() => {
  fakeDir = mkdtempSync(join(tmpdir(), 'jarvis-systemd-fake-'));
  for (const bin of ['systemctl', 'systemd-run', 'journalctl']) {
    const path = join(fakeDir, bin);
    writeFileSync(path, FAKE, 'utf-8');
    chmodSync(path, 0o755);
  }
  prevPath = process.env.PATH;
  process.env.PATH = `${fakeDir}:${prevPath ?? ''}`;
  // The lock and runUpdate's legacy restart both live under JARVIS_HOME.
  prevJarvisHome = process.env.JARVIS_HOME;
  process.env.JARVIS_HOME = fakeDir;
});

afterEach(async () => {
  if (holder) {
    holder.kill('SIGKILL');
    await holder.exited;
    holder = null;
  }
  if (prevPath === undefined) delete process.env.PATH;
  else process.env.PATH = prevPath;
  if (prevJarvisHome === undefined) delete process.env.JARVIS_HOME;
  else process.env.JARVIS_HOME = prevJarvisHome;
  rmSync(fakeDir, { recursive: true, force: true });
});

describe('parseCgroupPath', () => {
  test.each([
    ['unified (v2)', `0::${UNIT_CGROUP}\n`, UNIT_CGROUP],
    ['legacy v1 with an unused unified line', `12:pids:/user.slice\n1:name=systemd:${UNIT_CGROUP}\n0::/\n`, UNIT_CGROUP],
    ['legacy v1 without a unified line', `1:name=systemd:${UNIT_CGROUP}\n`, UNIT_CGROUP],
    ['hybrid prefers the unified line', `1:name=systemd:${TERMINAL_CGROUP}\n0::${UNIT_CGROUP}\n`, UNIT_CGROUP],
    ['container root', '0::/\n', null],
    ['empty', '', null],
  ])('%s', (_label, text, expected) => {
    expect(parseCgroupPath(text)).toBe(expected);
  });
});

describe('userUnitFromCgroup', () => {
  test.each([
    ['under app.slice', UNIT_CGROUP, { name: UNIT, cgroup: UNIT_CGROUP }],
    ['directly under the manager', `${MANAGER}/jarvis.service`, { name: 'jarvis.service', cgroup: `${MANAGER}/jarvis.service` }],
    ['template instance', `${MANAGER}/app.slice/jarvis@home.service`, { name: 'jarvis@home.service', cgroup: `${MANAGER}/app.slice/jarvis@home.service` }],
    ['escaped name', `${MANAGER}/app.slice/my\\x2djarvis.service`, { name: 'my\\x2djarvis.service', cgroup: `${MANAGER}/app.slice/my\\x2djarvis.service` }],
    ['Delegate= sub-cgroup', `${MANAGER}/app.slice/jarvis.service/payload`, { name: 'jarvis.service', cgroup: `${MANAGER}/app.slice/jarvis.service` }],
  ])('a user service: %s', (_label, path, expected) => {
    expect(userUnitFromCgroup(path, UID)).toEqual(expected);
  });

  test.each([
    ['a system unit', '/system.slice/jarvis.service'],
    ['a terminal scope', TERMINAL_CGROUP],
    ['the manager itself', `${MANAGER}/init.scope`],
    ['the manager cgroup', MANAGER],
    ['another user\'s manager', '/user.slice/user-1001.slice/user@1001.service/app.slice/jarvis.service'],
    ['a name that would read as an option', `${MANAGER}/app.slice/--force.service`],
  ])('not ours to route: %s', (_label, path) => {
    expect(userUnitFromCgroup(path, UID)).toBeNull();
  });
});

describe('detectSystemdUnit', () => {
  const base = { platform: 'linux' as const, uid: UID, lockHolder: () => 4242 };

  test('inside the unit: the CLI shares the daemon\'s cgroup', () => {
    setFile('mainpid', '4242');
    const unit = detectSystemdUnit({ ...base, readCgroup: cgroups({ 4242: UNIT_CGROUP, self: UNIT_CGROUP }) });
    expect(unit).toEqual({ name: UNIT, pid: 4242, inside: true, reachable: true, transient: false });
    expect(calls()).toEqual([['systemctl', '--user', 'show', UNIT, '--property=MainPID', '--property=Transient']]);
  });

  test('a transient unit is flagged', () => {
    setFile('mainpid', '4242');
    setFile('transient', 'yes');
    const unit = detectSystemdUnit({ ...base, readCgroup: cgroups({ 4242: UNIT_CGROUP, self: UNIT_CGROUP }) });
    expect(unit?.transient).toBe(true);
  });

  test('our own cgroup unreadable counts as inside: the safe side', () => {
    setFile('mainpid', '4242');
    const unit = detectSystemdUnit({ ...base, readCgroup: cgroups({ 4242: UNIT_CGROUP }) });
    expect(unit?.inside).toBe(true);
  });

  test('inside a Delegate= sub-cgroup of the unit still counts as inside', () => {
    setFile('mainpid', '4242');
    const unit = detectSystemdUnit({
      ...base,
      readCgroup: cgroups({ 4242: `${UNIT_CGROUP}/payload`, self: `${UNIT_CGROUP}/tools` }),
    });
    expect(unit).toEqual({ name: UNIT, pid: 4242, inside: true, reachable: true, transient: false });
  });

  test('outside the unit: a terminal, or a cgroup whose name merely starts the same', () => {
    setFile('mainpid', '4242');
    for (const self of [TERMINAL_CGROUP, `${UNIT_CGROUP}-other`]) {
      const unit = detectSystemdUnit({ ...base, readCgroup: cgroups({ 4242: UNIT_CGROUP, self }) });
      expect(unit).toEqual({ name: UNIT, pid: 4242, inside: false, reachable: true, transient: false });
    }
  });

  test('a daemon some other service spawned is not that service\'s main process', () => {
    setFile('mainpid', '777');
    const unit = detectSystemdUnit({ ...base, readCgroup: cgroups({ 4242: UNIT_CGROUP, self: UNIT_CGROUP }) });
    expect(unit).toBeNull();
  });

  test('systemctl unreachable: flagged, inside or out, so callers refuse rather than take the old path', () => {
    setFile('systemctl.exit', '1');
    expect(detectSystemdUnit({ ...base, readCgroup: cgroups({ 4242: UNIT_CGROUP, self: UNIT_CGROUP }) }))
      .toEqual({ name: UNIT, pid: 4242, inside: true, reachable: false });
    expect(detectSystemdUnit({ ...base, readCgroup: cgroups({ 4242: UNIT_CGROUP, self: TERMINAL_CGROUP }) }))
      .toEqual({ name: UNIT, pid: 4242, inside: false, reachable: false });
  });

  test('a systemctl that hangs counts as unreachable', () => {
    const unit = detectSystemdUnit({
      ...base,
      readCgroup: cgroups({ 4242: UNIT_CGROUP, self: UNIT_CGROUP }),
      run: () => ({ exitCode: null, stdout: '', stderr: 'timed out' }),
    });
    expect(unit?.reachable).toBe(false);
  });

  test('no daemon, a hand-started daemon, a system unit, or not Linux: systemctl is never asked', () => {
    expect(detectSystemdUnit({ ...base, lockHolder: () => null, readCgroup: cgroups({}) })).toBeNull();
    expect(detectSystemdUnit({ ...base, readCgroup: cgroups({ 4242: TERMINAL_CGROUP, self: TERMINAL_CGROUP }) })).toBeNull();
    expect(detectSystemdUnit({ ...base, readCgroup: cgroups({ 4242: '/system.slice/jarvis.service', self: '/system.slice/jarvis.service' }) })).toBeNull();
    expect(detectSystemdUnit({ ...base, platform: 'darwin', readCgroup: cgroups({ 4242: UNIT_CGROUP }) })).toBeNull();
    expect(calls()).toEqual([]);
  });
});

describe('restartSystemdUnit', () => {
  const inside: SystemdUnit = { name: UNIT, pid: 4242, inside: true, reachable: true };
  const outside: SystemdUnit = { ...inside, inside: false };

  test('inside: hands the restart to a transient timer and never restarts in-process', async () => {
    expect(await restartSystemdUnit(inside)).toBe(true);
    const all = calls();
    expect(all).toHaveLength(1);
    const [bin, ...args] = all[0]!;
    expect(bin).toBe('systemd-run');
    expect(args.slice(0, 4)).toEqual(['--user', '--quiet', '--collect', `--unit=${STEM}-restart`]);
    expect(args).toContain(`--on-active=${SCHEDULE_DELAY_SEC}s`);
    expect(args).toContain('--timer-property=AccuracySec=100ms');
    // What the timer runs: this PATH's systemctl, restarting the unit.
    expect(args.slice(-4)).toEqual([join(fakeDir, 'systemctl'), '--user', 'restart', UNIT]);
  });

  test('inside: a restart already pending is success, not a second restart', async () => {
    setFile('systemd-run.exit', '1');
    setFile('systemd-run.stderr', `Failed to start transient timer unit: Unit ${STEM}-restart.timer was already loaded or has a fragment file.`);
    expect(await restartSystemdUnit(inside)).toBe(true);
    expect(calls()).toHaveLength(1);
  });

  test('inside: a failed schedule reports failure and leaves the daemon alone', async () => {
    setFile('systemd-run.exit', '1');
    expect(await restartSystemdUnit(inside)).toBe(false);
    expect(calls().map((c) => c[0])).toEqual(['systemd-run']);
  });

  test('systemd unreachable, inside or out: refuses without touching anything', async () => {
    expect(await restartSystemdUnit({ ...inside, reachable: false })).toBe(false);
    expect(await restartSystemdUnit({ ...outside, reachable: false })).toBe(false);
    expect(calls()).toEqual([]);
  });

  test('outside: asks systemctl without blocking and waits for the new main process to hold the lock', async () => {
    setFile('state', 'ActiveState=active\nMainPID=5151\n');
    const ok = await restartSystemdUnit(outside, { lockHolder: () => 5151, pollMs: 10, waitMs: 2000 });
    expect(ok).toBe(true);
    const all = calls();
    expect(all[1]).toEqual(['systemctl', '--user', '--no-block', 'restart', UNIT]);
    expect(all[2]).toEqual(['systemctl', '--user', 'show', UNIT, '--property=ActiveState', '--property=MainPID']);
    expect(all.some((c) => c[0] === 'systemd-run')).toBe(false);
  });

  test('outside: a restart already in progress is waited for, not requested again', async () => {
    setFile('state', 'ActiveState=deactivating\nMainPID=4242\n');
    const ok = await restartSystemdUnit(outside, { lockHolder: () => 4242, pollMs: 10, waitMs: 200 });
    expect(ok).toBe(true); // still draining at the deadline is reported, not failed
    expect(calls().some((c) => c.includes('restart'))).toBe(false);
  });

  test('outside: systemd never replacing the main process is not a restart', async () => {
    setFile('state', 'ActiveState=active\nMainPID=4242\n');
    expect(await restartSystemdUnit(outside, { lockHolder: () => 4242, pollMs: 10, waitMs: 200 })).toBe(false);
  });

  test('outside: a new main process still starting up at the deadline is reported, not failed', async () => {
    setFile('state', 'ActiveState=active\nMainPID=5151\n');
    expect(await restartSystemdUnit(outside, { lockHolder: () => null, pollMs: 10, waitMs: 200 })).toBe(true);
  });

  test('outside: a unit already activating is waited for, not restarted again', async () => {
    setFile('state', 'ActiveState=activating\nMainPID=0\n');
    const pending = restartSystemdUnit(outside, { lockHolder: () => 5151, pollMs: 10, waitMs: 2000 });
    setFile('state', 'ActiveState=active\nMainPID=5151\n');
    expect(await pending).toBe(true);
    expect(calls().some((c) => c.includes('restart'))).toBe(false);
  });

  test('restart arguments are named as ignored', async () => {
    const lines: string[] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };
    try {
      await restartSystemdUnit(inside, { ignoredArgs: ['-d', '--port', '8080'] });
    } finally {
      console.log = log;
    }
    expect(lines.some((l) => l.includes('Ignoring -d --port 8080'))).toBe(true);
  });

  test.each([
    ['failed', 'ActiveState=failed\nMainPID=0\n'],
    ['auto-restarting', 'ActiveState=activating\nMainPID=0\n'],
  ])('outside: a unit left %s is a failure', async (_label, state) => {
    setFile('state', 'ActiveState=active\nMainPID=4242\n');
    const pending = restartSystemdUnit(outside, { lockHolder: () => null, pollMs: 10, waitMs: 300 });
    // The request goes out before the first await; the unit then ends up in `state`.
    expect(calls()).toContainEqual(['systemctl', '--user', '--no-block', 'restart', UNIT]);
    setFile('state', state);
    expect(await pending).toBe(false);
  });

  test('outside: systemctl refusing the restart fails without polling', async () => {
    setFile('state', 'ActiveState=active\nMainPID=4242\n');
    setFile('systemctl.restart.exit', '5');
    const ok = await restartSystemdUnit(outside, { lockHolder: () => 4242, pollMs: 10, waitMs: 200 });
    expect(ok).toBe(false);
    expect(calls()).toHaveLength(2);
  });
});

describe('runUpdate under a systemd user unit', () => {
  const FAST = { waitMs: 2000, pollMs: 10, followMs: 2000, follow: true };
  const inside: SystemdUnit = { name: UNIT, pid: 4242, inside: true, reachable: true };
  const outside: SystemdUnit = { ...inside, inside: false };
  const UPDATER = `${STEM}-update`;
  const bunGlobal = () => ({ method: 'bun-global' as const, reason: 'test' });

  function stopRecorder(): { stopDaemon: () => Promise<StopResult>; stops: number[] } {
    const stops: number[] = [];
    return {
      stops,
      stopDaemon: async () => {
        stops.push(Date.now());
        return { wasRunning: true, pid: 4242, graceful: true, stopped: true };
      },
    };
  }

  /** `systemdCallsBefore`: how many systemctl/systemd-run calls preceded each install step. */
  function recordingSpawn(result: Partial<SpawnResult> = {}): {
    spawn: (cmd: string[]) => SpawnResult;
    spawned: string[][];
    systemdCallsBefore: number[];
  } {
    const spawned: string[][] = [];
    const systemdCallsBefore: number[] = [];
    return {
      spawned,
      systemdCallsBefore,
      spawn: (cmd) => {
        spawned.push(cmd);
        systemdCallsBefore.push(calls().length);
        return { exitCode: result.exitCode ?? 0, stdout: result.stdout ?? 'installed', stderr: result.stderr ?? '' };
      },
    };
  }

  /** The verb of each systemctl call (`show`, `stop`, ...), in order. */
  function verbs(): string[] {
    return calls().filter((c) => c[0] === 'systemctl').map((c) => c.slice(1).find((a) => !a.startsWith('-'))!);
  }

  describe('the CLI a user or the assistant runs', () => {
    test('inside the unit: nothing is stopped or installed here; a transient unit runs the update', async () => {
      const { stopDaemon, stops } = stopRecorder();
      const { spawn, spawned } = recordingSpawn();
      const result = await withEnv({ BUN_INSTALL: '/opt/bun', JARVIS_TEST_SECRET_525: 'hunter2' }, () => runUpdate({
        packageRoot: fakeDir,
        spawn,
        detect: bunGlobal,
        checkRunning: () => 4242,
        stopDaemon,
        systemdUnit: () => inside,
        systemdWait: FAST,
      }));
      expect(result.outcome).toBe('delegated');
      expect(result.exitCode).toBe(0);
      expect(stops).toEqual([]);
      expect(spawned).toEqual([]);

      const all = calls();
      // A failed updater from an earlier run is cleared first, then the new one starts.
      expect(all[0]).toEqual(['systemctl', '--user', 'reset-failed', `${UPDATER}.service`]);
      expect(all).toHaveLength(2);
      const [bin, ...args] = all[1]!;
      expect(bin).toBe('systemd-run');
      expect(args).toContain(`--unit=${UPDATER}`);
      // Kept loaded when it fails, so its result can be read.
      expect(args).not.toContain('--collect');
      // However the updater ends, the service is started again, by its own unit.
      expect(args).toContain(`--property=ExecStopPost=${join(fakeDir, 'systemctl')} --user --no-block start ${UNIT}`);
      // Pins the updater to the unit, so it never spawns a detached daemon.
      expect(args).toContain(`--setenv=JARVIS_UPDATE_UNIT=${UNIT}`);
      expect(args).toContain(`--setenv=JARVIS_HOME=${fakeDir}`);
      expect(args).toContain('--setenv=BUN_INSTALL=/opt/bun');
      // Only the allowlist reaches the updater, never the rest of our environment.
      const passed = args.filter((a) => a.startsWith('--setenv=')).map((a) => a.slice('--setenv='.length).split('=')[0]!);
      expect(passed.filter((k) => k !== 'JARVIS_UPDATE_UNIT' && !UPDATE_ENV.includes(k))).toEqual([]);
      expect(args.slice(-3)).toEqual([process.execPath, join(fakeDir, 'bin', 'jarvis.ts'), 'update']);
    });

    test('inside the unit, systemd unreachable: refuses and changes nothing', async () => {
      const { stopDaemon, stops } = stopRecorder();
      const { spawn, spawned } = recordingSpawn();
      const result = await runUpdate({
        packageRoot: fakeDir, spawn, detect: bunGlobal, checkRunning: () => 4242, stopDaemon,
        systemdUnit: () => ({ ...inside, reachable: false }),
      });
      expect(result.exitCode).toBe(1);
      expect(stops).toEqual([]);
      expect(spawned).toEqual([]);
      expect(calls()).toEqual([]);
    });

    test('a transient service is not stopped: it could not be started again', async () => {
      const { spawn, spawned } = recordingSpawn();
      const result = await runUpdate({
        packageRoot: fakeDir, spawn, detect: bunGlobal, checkRunning: () => 4242, stopDaemon: stopRecorder().stopDaemon,
        systemdUnit: () => ({ ...inside, transient: true }),
      });
      expect(result.exitCode).toBe(1);
      expect(spawned).toEqual([]);
      expect(calls()).toEqual([]);
    });

    test('the transient updater cannot be started: failure, and nothing touched', async () => {
      setFile('systemd-run.exit', '1');
      const { stopDaemon, stops } = stopRecorder();
      const { spawn, spawned } = recordingSpawn();
      const result = await runUpdate({
        packageRoot: fakeDir, spawn, detect: bunGlobal, checkRunning: () => 4242, stopDaemon,
        systemdUnit: () => inside,
      });
      expect(result.outcome).toBe('failed');
      expect(result.exitCode).toBe(1);
      expect(stops).toEqual([]);
      expect(spawned).toEqual([]);
    });

    test('an update already running is reported, not started twice', async () => {
      setFile('systemd-run.exit', '1');
      setFile('systemd-run.stderr', `Failed to start transient service unit: Unit ${UPDATER}.service was already loaded or has a fragment file.`);
      const result = await runUpdate({
        packageRoot: fakeDir, spawn: recordingSpawn().spawn, detect: bunGlobal, checkRunning: () => 4242,
        stopDaemon: stopRecorder().stopDaemon, systemdUnit: () => inside,
      });
      expect(result.outcome).toBe('delegated');
      expect(result.exitCode).toBe(0);
    });

    test('outside the unit (a terminal): same transient updater, followed until it finishes', async () => {
      setFile(`state.${UPDATER}.service`, 'ActiveState=inactive\nMainPID=0\n');
      setFile(`state.${UNIT}`, 'ActiveState=active\nMainPID=5151\n');
      const { stopDaemon, stops } = stopRecorder();
      const { spawn, spawned } = recordingSpawn();
      const result = await runUpdate({
        packageRoot: fakeDir, spawn, detect: bunGlobal, checkRunning: () => 4242, stopDaemon,
        systemdUnit: () => outside, systemdWait: FAST,
      });
      expect(result.outcome).toBe('delegated');
      expect(result.exitCode).toBe(0);
      expect(stops).toEqual([]);
      expect(spawned).toEqual([]);
      expect(calls().some((c) => c[0] === 'systemd-run')).toBe(true);
    });

    test('outside the unit: a failed updater is reported as a failure and cleared', async () => {
      setFile(`state.${UPDATER}.service`, 'ActiveState=failed\nMainPID=0\n');
      const result = await runUpdate({
        packageRoot: fakeDir, spawn: recordingSpawn().spawn, detect: bunGlobal, checkRunning: () => 4242,
        stopDaemon: stopRecorder().stopDaemon, systemdUnit: () => outside, systemdWait: FAST,
      });
      expect(result.outcome).toBe('failed');
      expect(result.exitCode).toBe(1);
      expect(calls().at(-1)).toEqual(['systemctl', '--user', 'reset-failed', `${UPDATER}.service`]);
    });

    test('with checkRunning injected and no systemdUnit, nothing is detected: a test never reaches a real unit', async () => {
      const { stopDaemon, stops } = stopRecorder();
      await runUpdate({
        packageRoot: fakeDir, spawn: recordingSpawn().spawn, detect: bunGlobal, checkRunning: () => 4242,
        stopDaemon, restartDaemon: false,
      });
      expect(stops).toHaveLength(1);
      expect(calls()).toEqual([]);
    });

    test('outside the unit and not on a terminal (a sidecar\'s shell): hands off and returns at once', async () => {
      setFile(`state.${UPDATER}.service`, 'ActiveState=active\nMainPID=6000\n');
      const result = await runUpdate({
        packageRoot: fakeDir, spawn: recordingSpawn().spawn, detect: bunGlobal, checkRunning: () => 4242,
        stopDaemon: stopRecorder().stopDaemon, systemdUnit: () => outside, systemdWait: { ...FAST, follow: false },
      });
      expect(result.outcome).toBe('delegated');
      expect(result.exitCode).toBe(0);
      expect(calls().some((c) => c[0] === 'journalctl')).toBe(false);
      expect(verbs()).toEqual(['reset-failed']);
    });
  });

  describe('the transient updater (JARVIS_UPDATE_UNIT set)', () => {
    async function runDelegated(opts: { spawn?: ReturnType<typeof recordingSpawn>; unitEnv?: string } = {}) {
      const rec = opts.spawn ?? recordingSpawn();
      const stop = stopRecorder();
      const result = await withEnv({ JARVIS_UPDATE_UNIT: opts.unitEnv ?? UNIT }, () => runUpdate({
        packageRoot: fakeDir,
        spawn: rec.spawn,
        detect: bunGlobal,
        checkRunning: () => 4242,
        stopDaemon: stop.stopDaemon,
        // Must not be consulted: the updater is told its unit.
        systemdUnit: () => { throw new Error('detection ran in the delegated updater'); },
        systemdWait: FAST,
      }));
      return { result, ...rec, stops: stop.stops };
    }

    test('systemctl stop, install, systemctl start, and no detached daemon', async () => {
      setFile('mainpid', '4242');
      const newPid = await spawnLockHolder();
      setFile('state', `ActiveState=active\nMainPID=${newPid}\n`);
      const { result, spawned, systemdCallsBefore, stops } = await runDelegated();
      expect(result.outcome).toBe('updated');
      expect(result.exitCode).toBe(0);
      expect(stops).toEqual([]);
      expect(spawned).toEqual([['bun', 'update', '-g', '@usejarvis/brain']]);
      // show (is 4242 the unit's main process?), stop, [install], start, show...
      expect(systemdCallsBefore).toEqual([2]);
      expect(verbs().slice(0, 3)).toEqual(['show', 'stop', 'start']);
      expect(verbs().slice(3).every((v) => v === 'show')).toBe(true);
    }, LOCK_HOLDER_TIMEOUT);

    test('a failed update still starts the unit again, and fails', async () => {
      setFile('mainpid', '4242');
      const newPid = await spawnLockHolder();
      setFile('state', `ActiveState=active\nMainPID=${newPid}\n`);
      const { result } = await runDelegated({ spawn: recordingSpawn({ exitCode: 1, stdout: '', stderr: 'network down' }) });
      expect(result.outcome).toBe('failed');
      expect(result.exitCode).toBe(1);
      expect(verbs()).toContain('start');
    }, LOCK_HOLDER_TIMEOUT);

    test('the daemon already gone: no MainPID check, then stop, install, start', async () => {
      const newPid = await spawnLockHolder();
      setFile('state', `ActiveState=active\nMainPID=${newPid}\n`);
      const rec = recordingSpawn();
      const result = await withEnv({ JARVIS_UPDATE_UNIT: UNIT }, () => runUpdate({
        packageRoot: fakeDir, spawn: rec.spawn, detect: bunGlobal, checkRunning: () => null,
        stopDaemon: stopRecorder().stopDaemon, systemdWait: FAST,
      }));
      expect(result.outcome).toBe('updated');
      expect(rec.spawned).toEqual([['bun', 'update', '-g', '@usejarvis/brain']]);
      expect(rec.systemdCallsBefore).toEqual([1]);
      expect(verbs().slice(0, 2)).toEqual(['stop', 'start']);
    }, LOCK_HOLDER_TIMEOUT);

    test('a start that fails is a failure', async () => {
      setFile('mainpid', '4242');
      setFile('systemctl.start.exit', '1');
      const { result } = await runDelegated();
      expect(result.exitCode).toBe(1);
    });

    test('a stop that fails updates nothing and queues a start', async () => {
      setFile('mainpid', '4242');
      setFile('systemctl.stop.exit', '1');
      const { result, spawned } = await runDelegated();
      expect(result.outcome).toBe('failed');
      expect(spawned).toEqual([]);
      expect(calls().at(-1)).toEqual(['systemctl', '--user', '--no-block', 'start', UNIT]);
    });

    test('the running daemon is not that unit\'s main process: refuses, stops nothing', async () => {
      setFile('mainpid', '777');
      const { result, spawned, stops } = await runDelegated();
      expect(result.outcome).toBe('failed');
      expect(spawned).toEqual([]);
      expect(stops).toEqual([]);
      expect(verbs()).toEqual(['show']);
    });

    test('a value that is not a service name is refused', async () => {
      const { result, spawned, stops } = await runDelegated({ unitEnv: '--force.service' });
      expect(result.outcome).toBe('failed');
      expect(spawned).toEqual([]);
      expect(stops).toEqual([]);
      expect(calls()).toEqual([]);
    });
  });
});

describe('runCommand', () => {
  test('gives up on a systemctl that hangs', () => {
    // exec, so the timeout's signal reaches sleep itself and nothing outlives it.
    writeFileSync(join(fakeDir, 'systemctl'), '#!/bin/sh\nexec sleep 30\n', 'utf-8');
    const started = Date.now();
    const result = runCommand(['systemctl', '--user', 'show', UNIT], { timeoutMs: 200 });
    expect(result.exitCode).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test('supplies XDG_RUNTIME_DIR when this environment lost it', async () => {
    const uid = process.getuid?.();
    if (uid === undefined || !existsSync(`/run/user/${uid}`)) return;
    writeFileSync(join(fakeDir, 'systemctl'), `#!/bin/sh\nprintf '%s' "$XDG_RUNTIME_DIR"\n`, 'utf-8');
    const saved = process.env.XDG_RUNTIME_DIR;
    delete process.env.XDG_RUNTIME_DIR;
    try {
      expect(runCommand(['systemctl']).stdout).toBe(`/run/user/${uid}`);
    } finally {
      if (saved !== undefined) process.env.XDG_RUNTIME_DIR = saved;
    }
  });
});

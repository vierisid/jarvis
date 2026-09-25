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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
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
  INSTALL_STEP_TIMEOUT_MS,
  describeLastUpdate,
  parseTimespanMs,
  readLastUpdate,
  routeRestart,
  stopBudgetMs,
  updaterRuntimeMaxSec,
  writeLastUpdate,
  type LastUpdate,
  type SystemdUnit,
} from './systemd-unit.ts';
import { defaultSpawn, runUpdate, type SpawnResult, type UpdateResult } from './update.ts';
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
// `MainPID=` from the file `mainpid`, `Transient=` from `transient`,
// `ControlGroup=` from `cgroup` and `TimeoutStopUSec=` from `stoptimeout`. Exit
// codes come from `<binary>.<subcommand>.exit`, then `<binary>.exit`
// (default 0); stderr from `<binary>.stderr`. journalctl prints nothing.
const FAKE = `#!/bin/sh
dir=$(dirname "$0")
name=$(basename "$0")
if [ "$1" = --version ]; then echo "systemd $(cat "$dir/version" 2>/dev/null || echo 262) (fake)"; exit 0; fi
{ printf '%s\\037' "$name" "$@"; printf '\\n'; } >> "$dir/calls.log"
# systemd-run with a record.tpl: play the updater's part and leave its record,
# with this run's id in it.
if [ "$name" = systemd-run ] && [ -f "$dir/record.tpl" ]; then
  for a in "$@"; do case "$a" in --setenv=JARVIS_UPDATE_RUN=*) run=\${a#--setenv=JARVIS_UPDATE_RUN=} ;; esac; done
  sed "s/@RUN@/$run/" "$dir/record.tpl" > "$dir/last-update.json"
fi
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
      printf 'Transient=%s\\n' "$(cat "$dir/transient" 2>/dev/null || echo no)"
      printf 'ControlGroup=%s\\n' "$(cat "$dir/cgroup" 2>/dev/null)"
      printf 'TimeoutStopUSec=%s\\n' "$(cat "$dir/stoptimeout" 2>/dev/null || echo '1min 30s')" ;;
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
    expect(unit).toEqual({ name: UNIT, pid: 4242, inside: true, reachable: true, transient: false, stopTimeoutMs: 90_000 });
    expect(calls()).toEqual([['systemctl', '--user', 'show', UNIT,
      '--property=MainPID', '--property=Transient', '--property=ControlGroup', '--property=TimeoutStopUSec']]);
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
    expect(unit).toEqual({ name: UNIT, pid: 4242, inside: true, reachable: true, transient: false, stopTimeoutMs: 90_000 });
  });

  test('outside the unit: a terminal, or a cgroup whose name merely starts the same', () => {
    setFile('mainpid', '4242');
    for (const self of [TERMINAL_CGROUP, `${UNIT_CGROUP}-other`]) {
      const unit = detectSystemdUnit({ ...base, readCgroup: cgroups({ 4242: UNIT_CGROUP, self }) });
      expect(unit).toEqual({ name: UNIT, pid: 4242, inside: false, reachable: true, transient: false, stopTimeoutMs: 90_000 });
    }
  });

  test('a daemon some other service spawned is not that service\'s main process', () => {
    setFile('mainpid', '777');
    const unit = detectSystemdUnit({ ...base, readCgroup: cgroups({ 4242: UNIT_CGROUP, self: UNIT_CGROUP }) });
    expect(unit).toBeNull();
  });

  test('systemctl unreachable, inside the unit: flagged so callers refuse', () => {
    setFile('systemctl.exit', '1');
    expect(detectSystemdUnit({ ...base, readCgroup: cgroups({ 4242: UNIT_CGROUP, self: UNIT_CGROUP }) }))
      .toEqual({ name: UNIT, pid: 4242, inside: true, reachable: false });
  });

  test('systemctl unreachable, outside: a daemon the user manager started itself is the unit\'s main process: refuse', () => {
    setFile('systemctl.exit', '1');
    const unit = detectSystemdUnit({
      ...base,
      parentPid: () => 1,
      readCgroup: cgroups({ 4242: UNIT_CGROUP, 1: `${MANAGER}/init.scope`, self: TERMINAL_CGROUP }),
    });
    expect(unit).toEqual({ name: UNIT, pid: 4242, inside: false, reachable: false });
  });

  test('systemctl unreachable, outside: a daemon an unrelated service spawned takes the old path', () => {
    setFile('systemctl.exit', '1');
    const tmux = `${MANAGER}/app.slice/tmux.service`;
    const unit = detectSystemdUnit({
      ...base,
      parentPid: () => 999,
      readCgroup: cgroups({ 4242: tmux, 999: tmux, self: TERMINAL_CGROUP }),
    });
    expect(unit).toBeNull();
  });

  test('the unit\'s TimeoutStopSec is carried, infinity included', () => {
    setFile('mainpid', '4242');
    setFile('stoptimeout', '10min');
    const read = cgroups({ 4242: UNIT_CGROUP, self: TERMINAL_CGROUP });
    expect(detectSystemdUnit({ ...base, readCgroup: read })?.stopTimeoutMs).toBe(600_000);
    setFile('stoptimeout', 'infinity');
    expect(detectSystemdUnit({ ...base, readCgroup: read })?.stopTimeoutMs).toBe(Infinity);
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
      const result = await withEnv({
        BUN_INSTALL: '/opt/bun',
        HTTPS_PROXY: 'http://user:hunter2@proxy:3128',
        NODE_EXTRA_CA_CERTS: '/etc/corp-ca.pem',
        JARVIS_TEST_SECRET_525: 'hunter2',
        NPM_TOKEN: 'hunter2',
        npm_config__authToken: 'hunter2',
      }, () => runUpdate({
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
      expect(args).toContain(`--property=ExecStopPost="${join(fakeDir, 'systemctl')}" "--user" "--no-block" "start" "${UNIT}"`);
      // A hung updater is killed, and ExecStopPost still runs.
      expect(args.find((a) => a.startsWith('--property=RuntimeMaxSec='))).toBe(`--property=RuntimeMaxSec=${updaterRuntimeMaxSec({ stopTimeoutMs: null })}`);
      // Pins the updater to the unit, so it never spawns a detached daemon.
      expect(args).toContain(`--setenv=JARVIS_UPDATE_UNIT=${UNIT}`);
      // Everything else by name only: systemd-run copies the value from its own
      // environment, so a proxy password never lands on a command line.
      expect(args).toContain('--setenv=JARVIS_HOME');
      expect(args).toContain('--setenv=BUN_INSTALL');
      expect(args).toContain('--setenv=HTTPS_PROXY');
      expect(args).toContain('--setenv=NODE_EXTRA_CA_CERTS');
      expect(args.join(' ')).not.toContain('hunter2');
      // Only the allowlist reaches the updater: not the rest of our environment, not registry tokens.
      const passed = args.filter((a) => a.startsWith('--setenv=')).map((a) => a.slice('--setenv='.length).split('=')[0]!);
      expect(passed.filter((k) => k !== 'JARVIS_UPDATE_UNIT' && k !== 'JARVIS_UPDATE_RUN' && !UPDATE_ENV.includes(k))).toEqual([]);
      expect(passed).not.toContain('NPM_TOKEN');
      expect(passed).not.toContain('npm_config__authToken');
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

    /** What the transient updater leaves behind, written by the fake systemd-run with the run's id. */
    function updaterRecord(overrides: Partial<LastUpdate> = {}): void {
      setFile('record.tpl', JSON.stringify({
        outcome: 'updated', from: '1.0.0', to: '1.1.0', at: new Date().toISOString(),
        unit: UNIT, run: '@RUN@', serviceStarted: true, ...overrides,
      }));
    }

    async function followed(): Promise<{ result: UpdateResult; errors: string[]; lines: string[] }> {
      const errors: string[] = [];
      const lines: string[] = [];
      const [log, error] = [console.log, console.error];
      console.log = (...a: unknown[]) => { lines.push(a.join(' ')); };
      console.error = (...a: unknown[]) => { errors.push(a.join(' ')); };
      try {
        const result = await runUpdate({
          packageRoot: fakeDir, spawn: recordingSpawn().spawn, detect: bunGlobal, checkRunning: () => 4242,
          stopDaemon: stopRecorder().stopDaemon, systemdUnit: () => outside, systemdWait: FAST,
        });
        return { result, errors, lines };
      } finally {
        [console.log, console.error] = [log, error];
      }
    }

    test('outside the unit (a terminal): same transient updater, followed until it finishes', async () => {
      setFile(`state.${UPDATER}.service`, 'ActiveState=inactive\nMainPID=0\n');
      setFile(`state.${UNIT}`, 'ActiveState=active\nMainPID=5151\n');
      updaterRecord();
      const { result, lines } = await followed();
      expect(result.outcome).toBe('delegated');
      expect(result.exitCode).toBe(0);
      expect(calls().some((c) => c[0] === 'systemd-run')).toBe(true);
      expect(lines.some((l) => l.includes('Updated 1.0.0 → 1.1.0') && l.includes('PID 5151'))).toBe(true);
    });

    test('followed: an updater that left no record was killed or timed out', async () => {
      setFile(`state.${UPDATER}.service`, 'ActiveState=failed\nMainPID=0\n');
      const { result, errors } = await followed();
      expect(result.exitCode).toBe(1);
      expect(errors.join('\n')).toContain('did not finish');
    });

    test('followed: an older run\'s record, however recent, is not this run\'s result', async () => {
      setFile(`state.${UPDATER}.service`, 'ActiveState=failed\nMainPID=0\n');
      writeLastUpdate({
        outcome: 'updated', from: '1.0.0', to: '1.1.0', at: new Date(Date.now() + 60_000).toISOString(),
        unit: UNIT, run: 'an-earlier-run', serviceStarted: true,
      });
      const { result, errors } = await followed();
      expect(result.exitCode).toBe(1);
      expect(errors.join('\n')).toContain('did not finish');
    });

    test('before systemd 250, --setenv=KEY alone is refused, so values are passed', async () => {
      setFile('version', '249');
      await withEnv({ HTTPS_PROXY: 'http://proxy:3128' }, () => runUpdate({
        packageRoot: fakeDir, spawn: recordingSpawn().spawn, detect: bunGlobal, checkRunning: () => 4242,
        stopDaemon: stopRecorder().stopDaemon, systemdUnit: () => inside, systemdWait: FAST,
      }));
      const args = calls().find((c) => c[0] === 'systemd-run')!;
      expect(args).toContain('--setenv=HTTPS_PROXY=http://proxy:3128');
      expect(args).toContain(`--setenv=JARVIS_HOME=${fakeDir}`);
    });

    test('a systemctl path with $ in it reaches ExecStopPost with $ doubled', async () => {
      const odd = join(fakeDir, 'b$in');
      mkdirSync(odd);
      writeFileSync(join(odd, 'systemctl'), FAKE, 'utf-8');
      chmodSync(join(odd, 'systemctl'), 0o755);
      await withEnv({ PATH: `${odd}:${process.env.PATH}` }, () => runUpdate({
        packageRoot: fakeDir, spawn: recordingSpawn().spawn, detect: bunGlobal, checkRunning: () => 4242,
        stopDaemon: stopRecorder().stopDaemon, systemdUnit: () => inside, systemdWait: FAST,
      }));
      const args = calls().find((c) => c[0] === 'systemd-run')!;
      expect(args.find((a) => a.startsWith('--property=ExecStopPost='))).toStartWith(`--property=ExecStopPost="${odd.split('$').join('$$')}/systemctl"`);
    });

    test('followed: an installed update whose service did not come back is not reported as a failed install', async () => {
      setFile(`state.${UPDATER}.service`, 'ActiveState=failed\nMainPID=0\n');
      setFile(`state.${UNIT}`, 'ActiveState=failed\nMainPID=0\n');
      updaterRecord({ serviceStarted: false });
      const { result, errors } = await followed();
      expect(result.exitCode).toBe(1);
      expect(errors.join('\n')).toContain('The update was installed');
      expect(errors.join('\n')).not.toContain('The update failed');
    });

    test('followed: a failed install says why', async () => {
      setFile(`state.${UPDATER}.service`, 'ActiveState=failed\nMainPID=0\n');
      updaterRecord({ outcome: 'failed', to: '1.0.0', error: 'bun update failed' });
      const { result, errors } = await followed();
      expect(result.exitCode).toBe(1);
      expect(errors.join('\n')).toContain('The update failed: bun update failed');
    });

    test('an escaped unit name reaches ExecStopPost escaped, so the safety net starts the right unit', async () => {
      const escaped = 'my\\x2djarvis.service';
      await runUpdate({
        packageRoot: fakeDir, spawn: recordingSpawn().spawn, detect: bunGlobal, checkRunning: () => 4242,
        stopDaemon: stopRecorder().stopDaemon, systemdUnit: () => ({ ...inside, name: escaped }), systemdWait: FAST,
      });
      const args = calls().find((c) => c[0] === 'systemd-run')!;
      // systemd reads C escapes in Exec lines: `\\x2d` there is the literal `\x2d`.
      expect(args).toContain(`--property=ExecStopPost="${join(fakeDir, 'systemctl')}" "--user" "--no-block" "start" "my\\\\x2djarvis.service"`);
      // The name systemctl stops and starts directly is passed as is.
      expect(args).toContain(`--setenv=JARVIS_UPDATE_UNIT=${escaped}`);
      expect(args).toContain('--unit=my-x2djarvis-update');
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

    test('the daemon already gone: no MainPID match needed, then stop, install, start', async () => {
      setFile('mainpid', '0');
      const newPid = await spawnLockHolder();
      setFile('state', `ActiveState=active\nMainPID=${newPid}\n`);
      const rec = recordingSpawn();
      const result = await withEnv({ JARVIS_UPDATE_UNIT: UNIT }, () => runUpdate({
        packageRoot: fakeDir, spawn: rec.spawn, detect: bunGlobal, checkRunning: () => null,
        stopDaemon: stopRecorder().stopDaemon, systemdWait: FAST,
      }));
      expect(result.outcome).toBe('updated');
      expect(rec.spawned).toEqual([['bun', 'update', '-g', '@usejarvis/brain']]);
      expect(rec.systemdCallsBefore).toEqual([2]);
      expect(verbs().slice(0, 3)).toEqual(['show', 'stop', 'start']);
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

    test('run inside the unit it would stop (not a real updater): refuses, stops nothing', async () => {
      const self = parseCgroupPath(readFileSync('/proc/self/cgroup', 'utf-8'));
      if (!self) return; // no cgroup to be inside of here
      setFile('mainpid', '4242');
      setFile('cgroup', self);
      const { result, spawned, stops } = await runDelegated();
      expect(result.outcome).toBe('failed');
      expect(spawned).toEqual([]);
      expect(stops).toEqual([]);
      expect(verbs()).toEqual(['show']);
    });

    test('the result is recorded for jarvis status', async () => {
      setFile('mainpid', '4242');
      const newPid = await spawnLockHolder();
      setFile('state', `ActiveState=active\nMainPID=${newPid}\n`);
      await runDelegated({ spawn: recordingSpawn({ exitCode: 1, stdout: '', stderr: 'network down' }) });
      const record = readLastUpdate();
      expect(record).toMatchObject({ outcome: 'failed', unit: UNIT, serviceStarted: true, error: 'bun update -g: network down' });
      expect(describeLastUpdate(record!)).toStartWith('Last update: failed (');
      expect(describeLastUpdate(record!)).toContain('): bun update -g: network down');
    }, LOCK_HOLDER_TIMEOUT);

    test('an update that changed nothing is recorded as up to date, not updated', async () => {
      setFile('mainpid', '4242');
      const newPid = await spawnLockHolder();
      setFile('state', `ActiveState=active\nMainPID=${newPid}\n`);
      await withEnv({ JARVIS_UPDATE_RUN: 'r1' }, () => runDelegated());
      const record = readLastUpdate();
      expect(record).toMatchObject({ outcome: 'up-to-date', run: 'r1' });
      expect(record!.to).toBe(record!.from);
    }, LOCK_HOLDER_TIMEOUT);

    test('a refusal leaves a failed record, so the terminal does not blame a kill', async () => {
      setFile('mainpid', '777');
      await withEnv({ JARVIS_UPDATE_RUN: 'r2' }, () => runDelegated());
      expect(readLastUpdate()).toMatchObject({ outcome: 'failed', run: 'r2', serviceStarted: true });
    });

    test('install steps share one deadline', async () => {
      setFile('mainpid', '4242');
      setFile('systemctl.start.exit', '1');
      const timeouts: number[] = [];
      await withEnv({ JARVIS_UPDATE_UNIT: UNIT }, () => runUpdate({
        packageRoot: fakeDir,
        spawn: (_cmd, options) => { timeouts.push(options?.timeoutMs ?? -1); return { exitCode: 0, stdout: '', stderr: '' }; },
        detect: bunGlobal, checkRunning: () => 4242, stopDaemon: stopRecorder().stopDaemon, systemdWait: FAST,
      }));
      expect(timeouts).toHaveLength(1);
      expect(timeouts[0]).toBeGreaterThan(0);
      expect(timeouts[0]).toBeLessThanOrEqual(INSTALL_STEP_TIMEOUT_MS);
    });
  });
});

describe('routeRestart (jarvis restart)', () => {
  const unit: SystemdUnit = { name: UNIT, pid: 4242, inside: true, reachable: true };

  test('a detected unit is restarted through systemd, never by the old stop/start path', async () => {
    const restarted: Array<{ unit: SystemdUnit; args?: string[] }> = [];
    const routed = await routeRestart(['-d'], {
      detect: () => unit,
      restart: async (u, o) => { restarted.push({ unit: u, args: o.ignoredArgs }); return true; },
    });
    expect(routed).toBe('done');
    expect(restarted).toEqual([{ unit, args: ['-d'] }]);
  });

  test('a failed systemd restart is a failure, not a fall-through to the old path', async () => {
    expect(await routeRestart([], { detect: () => unit, restart: async () => false })).toBe('failed');
  });

  test('no unit: the old path', async () => {
    let called = false;
    expect(await routeRestart([], { detect: () => null, restart: async () => { called = true; return true; } })).toBe('legacy');
    expect(called).toBe(false);
  });
});

describe('time spans and budgets', () => {
  test.each([
    ['1min 30s', 90_000], ['90s', 90_000], ['500ms', 500], ['2h', 7_200_000], ['infinity', Infinity], ['', null], ['soon', null],
    ['1month 5d', 2_629_800_000 + 5 * 86_400_000], ['1y', 31_557_600_000],
  ])('parseTimespanMs(%p)', (text, expected) => {
    expect(parseTimespanMs(text)).toBe(expected);
  });

  test('the stop budget: at least 3 minutes, the unit\'s timeout plus 30 s, at most an hour and a bit', () => {
    expect(stopBudgetMs({ stopTimeoutMs: null })).toBe(180_000);
    expect(stopBudgetMs({ stopTimeoutMs: 600_000 })).toBe(630_000);
    expect(stopBudgetMs({ stopTimeoutMs: Infinity })).toBe(3_630_000);
  });

  test('the updater outlives its stop, its install steps and its start', () => {
    expect(updaterRuntimeMaxSec({ stopTimeoutMs: null })).toBe(180 + 30 * 60 + 120);
    expect(updaterRuntimeMaxSec({ stopTimeoutMs: 600_000 })).toBeGreaterThan(630 + 30 * 60);
  });
});

describe('describeLastUpdate', () => {
  test('an unreadable time is left out, not printed as Invalid Date', () => {
    const line = describeLastUpdate({ outcome: 'updated', from: '1.0.0', to: '1.1.0', at: 'garbage', unit: UNIT, serviceStarted: true });
    expect(line).toBe('Last update: updated 1.0.0 → 1.1.0');
  });
});

describe('defaultSpawn (the install steps)', () => {
  test('a hung step is stopped and fails with a reason', () => {
    const started = Date.now();
    // exec, so the timeout's signal reaches sleep itself and nothing outlives it.
    const result = defaultSpawn(['sh', '-c', 'exec sleep 30'], { timeoutMs: 200 });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('was stopped after');
    expect(Date.now() - started).toBeLessThan(5000);
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

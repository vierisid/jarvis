/**
 * Integration tests against a REAL systemd user manager.
 *
 * The rest of the suite simulates a supervisor with a process that spins on
 * acquireLock. That models the shape but proves nothing about systemd itself —
 * and the two worst regressions in this area were found in exactly the
 * launchd/systemd paths. These tests use a genuine `Restart=always` unit:
 *
 *  1. the lockfile survives a stop when systemd relaunches the daemon;
 *  2. the escaped `Environment=` line we generate round-trips through systemd's
 *     own parser back to the exact path.
 *
 * Skipped wherever `systemctl --user` is unusable (containers, most CI
 * runners, macOS), so this is a local/dev-machine gate rather than a CI one.
 * Units are linked under a unique per-run name and unlinked afterwards; they
 * never touch the real `jarvis.service`.
 */
import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { stopDaemonGracefully } from './daemon-control.ts';
import { generateSystemdUnit } from './autostart.ts';
import { isLocked } from '../daemon/pid.ts';

const PID_MODULE = join(import.meta.dir, '..', 'daemon', 'pid.ts');
const UNIT_PREFIX = `jarvis-itest-${process.pid}`;
const USER_UNIT_DIR = join(process.env.HOME ?? '', '.config', 'systemd', 'user');

function sh(cmd: string[]): { code: number; out: string } {
  const r = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'pipe' });
  return { code: r.exitCode ?? -1, out: `${r.stdout.toString()}${r.stderr.toString()}`.trim() };
}

function systemdUsable(): boolean {
  if (process.platform !== 'linux') return false;
  if (!Bun.which('systemctl')) return false;
  // `is-system-running` exits non-zero when degraded but still manageable, so
  // fall back to a command that only works with a reachable user manager.
  return sh(['systemctl', '--user', 'is-system-running']).code === 0
    || sh(['systemctl', '--user', 'show-environment']).code === 0;
}

const ENABLED = systemdUsable();

let DATA_DIR: string;
let prevJarvisHome: string | undefined;
const linkedUnits: string[] = [];

/** Link + start a unit built from `body`; returns its unit name. */
function startUnit(name: string, body: string): void {
  const unitPath = join(DATA_DIR, `${name}.service`);
  writeFileSync(unitPath, body, 'utf-8');

  const link = sh(['systemctl', '--user', 'link', unitPath]);
  if (link.code !== 0) throw new Error(`systemctl link failed: ${link.out}`);
  linkedUnits.push(name);

  const start = sh(['systemctl', '--user', 'start', `${name}.service`]);
  if (start.code !== 0) throw new Error(`systemctl start failed: ${start.out}`);
}

function stopAndUnlink(name: string): void {
  sh(['systemctl', '--user', 'stop', `${name}.service`]);
  sh(['systemctl', '--user', 'disable', `${name}.service`]);
  try { rmSync(join(USER_UNIT_DIR, `${name}.service`), { force: true }); } catch { /* ignore */ }
}

describe.skipIf(!ENABLED)('daemon stop under a real systemd supervisor', () => {
  beforeAll(() => {
    prevJarvisHome = process.env.JARVIS_HOME;
    DATA_DIR = mkdtempSync(join(tmpdir(), 'jarvis-systemd-test-'));
    process.env.JARVIS_HOME = DATA_DIR;
  });

  afterAll(() => {
    for (const name of linkedUnits) stopAndUnlink(name);
    if (linkedUnits.length > 0) sh(['systemctl', '--user', 'daemon-reload']);
    if (prevJarvisHome === undefined) delete process.env.JARVIS_HOME;
    else process.env.JARVIS_HOME = prevJarvisHome;
    try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('systemd relaunch keeps its lockfile through a stop', async () => {
    const holder = join(DATA_DIR, 'holder.ts');
    writeFileSync(holder, `
import { acquireLock } from ${JSON.stringify(PID_MODULE)};
while (!acquireLock(process.pid)) await Bun.sleep(20);
await Bun.sleep(600000);
`, 'utf-8');

    const name = `${UNIT_PREFIX}-relaunch`;
    startUnit(name, `[Unit]
Description=jarvis lock relaunch probe
[Service]
Type=simple
ExecStart=${Bun.which('bun')} ${holder}
Restart=always
RestartSec=0
Environment="JARVIS_HOME=${DATA_DIR}"
`);

    // Wait for the supervised process to take the lock.
    const deadline = Date.now() + 30_000;
    let originalPid: number | null = null;
    while (Date.now() < deadline && originalPid === null) {
      originalPid = isLocked();
      if (originalPid === null) await Bun.sleep(100);
    }
    expect(originalPid).not.toBeNull();

    // 2s poll: a measured systemd relaunch takes ~90ms, so the replacement is
    // reliably holding the lock by the time the stop makes its decision.
    const result = await stopDaemonGracefully({ timeoutMs: 8000, pollIntervalMs: 2000 });

    const newPid = isLocked();
    expect(newPid).not.toBeNull();          // systemd brought it back
    expect(newPid).not.toBe(originalPid);   // under a different pid
    expect(result.stopped).toBe(false);     // so we did NOT stop the daemon
    expect(existsSync(join(DATA_DIR, 'jarvis.pid'))).toBe(true); // and left its lock alone
  }, 60_000);

  test('the generated Environment= line round-trips through systemd', () => {
    // A path with every character that systemd treats specially inside a
    // quoted value: whitespace, %, backslash, and a double quote.
    const hostile = `${DATA_DIR}/we ird/100%/back\\slash/qu"ote`;
    const prev = process.env.JARVIS_HOME;
    process.env.JARVIS_HOME = hostile;
    let envLine: string;
    try {
      envLine = generateSystemdUnit()
        .split('\n')
        .find((l) => l.startsWith('Environment="JARVIS_HOME='))!;
    } finally {
      process.env.JARVIS_HOME = prev;
    }
    expect(envLine).toBeDefined();

    const outFile = join(DATA_DIR, 'roundtrip.txt');
    const dump = join(DATA_DIR, 'dump-env.ts');
    writeFileSync(dump,
      `import { writeFileSync } from 'node:fs';\n`
      + `writeFileSync(${JSON.stringify(outFile)}, process.env.JARVIS_HOME ?? '<unset>');\n`,
      'utf-8');

    const name = `${UNIT_PREFIX}-env`;
    startUnit(name, `[Unit]
Description=jarvis env round-trip probe
[Service]
Type=oneshot
ExecStart=${Bun.which('bun')} ${dump}
${envLine}
`);

    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !existsSync(outFile)) {
      Bun.spawnSync(['sleep', '0.05']); // sync wait: this test is not async
    }
    expect(existsSync(outFile)).toBe(true);
    // systemd's parser must hand the daemon back the ORIGINAL path — if the
    // escaping is wrong the value arrives truncated at the first space, or the
    // unit fails to load at all.
    expect(readFileSync(outFile, 'utf-8')).toBe(hostile);
  }, 60_000);
});

/**
 * Integration test against a REAL launchd user agent.
 *
 * The macOS counterpart to daemon-control.systemd.test.ts. It matters more than
 * the systemd one: the ordering bug it was written for -- stopping the daemon
 * before unloading the agent -- was a macOS-only deadlock, because the plist
 * JARVIS installed set `KeepAlive` true and launchd brought the daemon straight
 * back. The shipped plist no longer does (#549: a KeepAlive DICT with
 * `SuccessfulExit=false`); the first test below keeps a `KeepAlive=true` fixture
 * on purpose, because what it exercises is the supervisor, and `jarvis uninstall`
 * still meets such a plist on any install made before #549.
 *
 * The second describe is what proves #549 itself, and it can only be proved
 * here: a clean exit must be left alone, and an unsuccessful one must come back.
 * Both were reasoned from launchd's man page on a Linux box; this job is the only
 * place that measures them.
 *
 * Skipped off darwin (so it no-ops on Linux dev machines and the ubuntu CI job)
 * and runs on the macOS runner. Every agent is installed under a unique label
 * and booted out afterwards; none of them touches the real `ai.jarvis.daemon`.
 */
import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { stopDaemonGracefully } from './daemon-control.ts';
import { isLocked, isProcessAlive } from '../daemon/pid.ts';

const PID_MODULE = join(import.meta.dir, '..', 'daemon', 'pid.ts');
const LABEL = `ai.jarvis.itest.${process.pid}`;
const AGENT_DIR = join(homedir(), 'Library', 'LaunchAgents');
const PLIST_PATH = join(AGENT_DIR, `${LABEL}.plist`);

const ENABLED = process.platform === 'darwin' && Boolean(Bun.which('launchctl'));

function sh(cmd: string[]): { code: number; out: string } {
  const r = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'pipe' });
  return { code: r.exitCode ?? -1, out: `${r.stdout.toString()}${r.stderr.toString()}`.trim() };
}

let DATA_DIR: string;
let prevJarvisHome: string | undefined;
let booted = false;

describe.skipIf(!ENABLED)('daemon stop under a real launchd supervisor', () => {
  beforeAll(() => {
    prevJarvisHome = process.env.JARVIS_HOME;
    DATA_DIR = mkdtempSync(join(tmpdir(), 'jarvis-launchd-test-'));
    process.env.JARVIS_HOME = DATA_DIR;
    mkdirSync(AGENT_DIR, { recursive: true });
  });

  afterAll(() => {
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (booted) {
      if (uid !== null) sh(['launchctl', 'bootout', `gui/${uid}/${LABEL}`]);
      sh(['launchctl', 'unload', PLIST_PATH]);
    }
    try { if (existsSync(PLIST_PATH)) unlinkSync(PLIST_PATH); } catch { /* ignore */ }
    if (prevJarvisHome === undefined) delete process.env.JARVIS_HOME;
    else process.env.JARVIS_HOME = prevJarvisHome;
    try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('launchd relaunch keeps its lockfile through a stop', async () => {
    const holder = join(DATA_DIR, 'holder.ts');
    writeFileSync(holder, `
import { acquireLock } from ${JSON.stringify(PID_MODULE)};
while (!acquireLock(process.pid)) await Bun.sleep(20);
await Bun.sleep(600000);
`, 'utf-8');

    // ThrottleInterval=1: launchd otherwise refuses to respawn a job more than
    // once per 10s, which would make the relaunch arrive after the stop has
    // already decided. The real plist keeps the default — this is about
    // exercising the supervisor, not reproducing the shipped file.
    writeFileSync(PLIST_PATH, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${Bun.which('bun')}</string>
    <string>${holder}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>1</integer>
  <key>EnvironmentVariables</key>
  <dict>
    <key>JARVIS_HOME</key>
    <string>${DATA_DIR}</string>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
`, 'utf-8');

    // Same load path as installAutostart: bootstrap into the GUI domain, with
    // the legacy `load` as fallback.
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    let loaded = uid !== null && sh(['launchctl', 'bootstrap', `gui/${uid}`, PLIST_PATH]).code === 0;
    if (!loaded) {
      const legacy = sh(['launchctl', 'load', PLIST_PATH]);
      loaded = legacy.code === 0;
      if (!loaded) throw new Error(`launchctl could not load the test agent: ${legacy.out}`);
    }
    booted = true;

    // Wait for the supervised process to take the lock.
    const deadline = Date.now() + 60_000;
    let originalPid: number | null = null;
    while (Date.now() < deadline && originalPid === null) {
      originalPid = isLocked();
      if (originalPid === null) await Bun.sleep(200);
    }
    expect(originalPid).not.toBeNull();

    // 4s poll: launchd respawn is slower and less predictable than systemd's
    // ~90ms, so give the replacement room to take the lock before the stop
    // makes its decision.
    const result = await stopDaemonGracefully({ timeoutMs: 20_000, pollIntervalMs: 4000 });

    const newPid = isLocked();
    expect(newPid).not.toBeNull();          // launchd brought it back
    expect(newPid).not.toBe(originalPid);   // under a different pid
    expect(result.stopped).toBe(false);     // so we did NOT stop the daemon
    expect(existsSync(join(DATA_DIR, 'jarvis.pid'))).toBe(true); // and left its lock alone
  }, 120_000);
});

// ── #549: what a KeepAlive DICT relaunches ─────────────────────
//
// The shipped plist's KeepAlive is `{SuccessfulExit: false}`, launchd's
// Restart=on-failure. Two claims rest on it, and neither can be observed off
// macOS: a `jarvis stop` (clean drain, exit 0) must STAY stopped, and a crash
// (exit 3/4 since #543) must still be relaunched. ThrottleInterval=1 as above,
// so a relaunch that is coming arrives inside the window rather than 10s later.
//
// Not covered, deliberately: a death by SIGKILL. `jarvis stop` escalates to one
// when the drain overruns, and launchd's "inverse condition" should relaunch it,
// but that reading is unverified and src/cli/uninstall.ts is correct either way
// (it removes autostart BEFORE stopping the daemon).
describe.skipIf(!ENABLED)('KeepAlive={SuccessfulExit:false} under a real launchd', () => {
  const UID = typeof process.getuid === 'function' ? process.getuid() : null;
  let dir: string;
  let prevHome: string | undefined;
  const loaded: string[] = [];

  beforeAll(() => {
    prevHome = process.env.JARVIS_HOME;
    dir = mkdtempSync(join(tmpdir(), 'jarvis-launchd-keepalive-'));
    process.env.JARVIS_HOME = dir;
  });

  afterAll(() => {
    for (const label of loaded) {
      if (UID !== null) sh(['launchctl', 'bootout', `gui/${UID}/${label}`]);
      const path = join(dir, `${label}.plist`);
      sh(['launchctl', 'unload', path]);
      try { if (existsSync(path)) unlinkSync(path); } catch { /* ignore */ }
    }
    if (prevHome === undefined) delete process.env.JARVIS_HOME;
    else process.env.JARVIS_HOME = prevHome;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  /**
   * Load an agent that takes the real lock and then exits with `exitCode` on
   * SIGTERM, releasing the lock first so a relaunch can take it again. Returns
   * the pid that took the lock.
   */
  async function bootHolder(name: string, exitCode: number): Promise<number> {
    const label = `ai.jarvis.itest.${process.pid}.${name}`;
    const holder = join(dir, `${name}.ts`);
    writeFileSync(holder, `
import { acquireLock, releaseLock } from ${JSON.stringify(PID_MODULE)};
while (!acquireLock(process.pid)) await Bun.sleep(20);
process.on('SIGTERM', () => { releaseLock(); process.exit(${exitCode}); });
await Bun.sleep(600000);
`, 'utf-8');

    // In the tmp dir, NOT ~/Library/LaunchAgents: `launchctl bootstrap` reads any
    // path, and a fixture left in the real agents directory by a killed run would
    // be loaded at the next login and then relaunched every ThrottleInterval,
    // forever, against a holder script under a deleted tmpdir.
    const path = join(dir, `${label}.plist`);
    // Registered for cleanup BEFORE the load, so a load that half-succeeds is
    // still booted out; and booted out first, because the darwin job runs
    // `bun test --retry=2` and afterAll has not run between attempts -- without
    // this the retry only ever fails with "already loaded".
    loaded.push(label);
    if (UID !== null) sh(['launchctl', 'bootout', `gui/${UID}/${label}`]);
    writeFileSync(path, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${Bun.which('bun')}</string>
    <string>${holder}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>1</integer>
  <key>EnvironmentVariables</key>
  <dict>
    <key>JARVIS_HOME</key>
    <string>${dir}</string>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
`, 'utf-8');

    let ok = UID !== null && sh(['launchctl', 'bootstrap', `gui/${UID}`, path]).code === 0;
    if (!ok) ok = sh(['launchctl', 'load', path]).code === 0;
    if (!ok) throw new Error(`launchctl could not load ${label}`);

    const deadline = Date.now() + 60_000;
    let pid: number | null = null;
    while (Date.now() < deadline && pid === null) {
      pid = isLocked();
      if (pid === null) await Bun.sleep(200);
    }
    if (pid === null) throw new Error(`${label} never took the lock`);
    return pid;
  }

  test('a clean exit is left alone, so `jarvis stop` stays stopped', async () => {
    const pid = await bootHolder('clean', 0);

    const result = await stopDaemonGracefully({ timeoutMs: 20_000, pollIntervalMs: 1000 });
    expect(result.stopped).toBe(true);

    // Long enough that a relaunch throttled to 1s would have happened twice.
    await Bun.sleep(8000);
    expect(isLocked()).toBeNull();
    expect(isProcessAlive(pid)).toBe(false);
  }, 120_000);

  test('an unsuccessful exit is still relaunched', async () => {
    // Exit 3 is what an uncaught exception in the daemon exits with (#543), i.e.
    // the case the agent exists for. That supervision must survive #549.
    const pid = await bootHolder('crash', 3);

    await stopDaemonGracefully({ timeoutMs: 20_000, pollIntervalMs: 1000 });

    const deadline = Date.now() + 60_000;
    let replacement: number | null = null;
    while (Date.now() < deadline) {
      replacement = isLocked();
      if (replacement !== null && replacement !== pid) break;
      await Bun.sleep(250);
    }
    expect(replacement).not.toBeNull();
    expect(replacement).not.toBe(pid);
  }, 120_000);
});

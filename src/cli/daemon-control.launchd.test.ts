/**
 * Integration test against a REAL launchd user agent.
 *
 * The macOS counterpart to daemon-control.systemd.test.ts. It matters more than
 * the systemd one: the ordering bug this PR fixes — stopping the daemon before
 * unloading the agent — was a macOS-only deadlock, because the plist we install
 * sets `KeepAlive` true and launchd brings the daemon straight back.
 *
 * Skipped off darwin (so it no-ops on Linux dev machines and the ubuntu CI job)
 * and runs on the macOS runner. The agent is installed under a unique label and
 * booted out afterwards; it never touches the real `ai.jarvis.daemon`.
 */
import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { stopDaemonGracefully } from './daemon-control.ts';
import { isLocked } from '../daemon/pid.ts';

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

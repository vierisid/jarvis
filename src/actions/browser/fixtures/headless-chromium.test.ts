/**
 * The test-browser fixture must not outlive its owner (#524). A bun test run
 * that bails or is SIGKILLed never reaches afterAll, which is how orphaned
 * Chromiums used to pile up holding the fixed CDP port.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromiumExe, launchTestChromium, processAlive as alive } from './headless-chromium.ts';

async function gone(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await Bun.sleep(100);
  }
  return !alive(pid);
}

describe('BrowserController autoLaunch: false', () => {
  test('refuses instead of launching a browser when nothing answers on the port', async () => {
    // A port that was free a moment ago: nothing answers on it.
    const probe = Bun.serve({ port: 0, fetch: () => new Response('') });
    const port = probe.port!;
    probe.stop(true);
    // If this ever regresses it must not put a window on a real desktop.
    const saved = { DISPLAY: process.env.DISPLAY, WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY };
    delete process.env.DISPLAY;
    delete process.env.WAYLAND_DISPLAY;
    try {
      const { BrowserController } = await import('../session.ts');
      const ctrl = new BrowserController(port, undefined, { autoLaunch: false });
      await expect(ctrl.connect()).rejects.toThrow(/auto-launch is disabled/);
    } finally {
      for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
    }
  });
});

const falseExe = process.platform === 'win32' ? null : Bun.which('false');

describe.skipIf(!falseExe)('launchTestChromium startup failure', () => {
  // Under dash (/bin/sh on Ubuntu CI) the watchdog does not reap a child that
  // dies while it sits in `read`, so the dead browser is a zombie that still
  // answers kill(pid, 0). The fail-fast has to see through that, or this
  // waits out the whole startup deadline and reports the wrong cause. Run
  // this file with dash first on PATH as `sh` to exercise that path.
  test('a browser that exits at once fails fast, with the cause, and cleans up', async () => {
    // Unique per run, so another checkout's leftovers cannot confuse the check.
    const prefix = `jarvis-fixture-startfail-${process.pid}-`;
    const started = Date.now();
    const err = await launchTestChromium({ profilePrefix: prefix, startupMs: 20_000, executable: falseExe! })
      .then(() => null, (e: Error) => e);
    expect(err?.message).toMatch(/exited during startup/);
    expect(Date.now() - started).toBeLessThan(5_000);
    // The profile went with it (close() ran on the failure path).
    expect([...new Bun.Glob(`${prefix}*`).scanSync({ cwd: tmpdir(), onlyFiles: false })]).toEqual([]);
  }, 30_000);
});

describe.skipIf(!chromiumExe)('launchTestChromium', () => {
  test('answers on the port it wrote, and close() removes browser and profile', async () => {
    const chromium = await launchTestChromium({ profilePrefix: 'jarvis-fixture-test-' });
    try {
      expect(alive(chromium.pid)).toBe(true);
      const written = readFileSync(join(chromium.profileDir, 'DevToolsActivePort'), 'utf8').split('\n')[0];
      expect(Number(written)).toBe(chromium.port);
      const res = await fetch(`http://127.0.0.1:${chromium.port}/json/version`);
      expect(res.ok).toBe(true);
    } finally {
      await chromium.close();
    }
    expect(await gone(chromium.pid, 2_000)).toBe(true);
    expect(existsSync(chromium.profileDir)).toBe(false);
    await chromium.close(); // idempotent
  }, 60_000);

  test('the browser dies with its owner even when the owner is SIGKILLed', async () => {
    // A separate bun process owns the browser and is then killed outright, so
    // no JS of the owner runs at exit. Only the watchdog can clean up.
    const owner = Bun.spawn(['bun', '-e', `
      const { launchTestChromium } = await import(${JSON.stringify(join(import.meta.dir, 'headless-chromium.ts'))});
      const c = await launchTestChromium({ profilePrefix: 'jarvis-fixture-test-' });
      console.log(JSON.stringify({ pid: c.pid, profileDir: c.profileDir }));
      setInterval(() => {}, 1000);
    `], { stdout: 'pipe', stderr: 'ignore' });
    let info: { pid: number; profileDir: string } | null = null;
    try {
      const reader = owner.stdout.getReader();
      let text = '';
      const deadline = Date.now() + 50_000;
      while (!text.includes('\n') && Date.now() < deadline) {
        const chunk = await Promise.race([reader.read(), Bun.sleep(1_000).then(() => null)]);
        if (chunk?.done) break;
        if (chunk) text += new TextDecoder().decode(chunk.value);
      }
      reader.releaseLock();
      info = JSON.parse(text.split('\n')[0]!) as { pid: number; profileDir: string };
      expect(alive(info.pid)).toBe(true);
    } finally {
      owner.kill('SIGKILL');
      await owner.exited;
    }
    try {
      // The watchdog's TERM grace is 5s.
      expect(await gone(info!.pid, 8_000)).toBe(true);
      const deadline = Date.now() + 2_000;
      while (existsSync(info!.profileDir) && Date.now() < deadline) await Bun.sleep(100);
      expect(existsSync(info!.profileDir)).toBe(false);
    } finally {
      // Never leave one behind if the assertion above failed.
      if (info && alive(info.pid)) try { process.kill(info.pid, 'SIGKILL'); } catch { /* raced */ }
    }
  }, 70_000);
});

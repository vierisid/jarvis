/**
 * The macOS/Windows fallback seam, run for real against /bin/sh scripts.
 *
 * #893: defaultExec was spawnSync, so a script that hit its 30 s bound held
 * the daemon's event loop for all of it. It is awaited now; the first test
 * pins that the loop keeps turning while a hung script runs.
 *
 * Every wait on a call here is settled against a deadline rather than with
 * `await expect(p).rejects`, which hangs Bun 1.3.8's runner when p never
 * settles: a regression fails instead of stalling the run.
 *
 * POSIX-only: the scripts are `#!/bin/sh`.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __setNativeExecMaxOutputForTests, __setNativeExecTimeoutForTests, defaultExec, runNative } from './native-exec.ts';

const dir = mkdtempSync(join(tmpdir(), 'jarvis-native-exec-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => {
  __setNativeExecTimeoutForTests(null);
  __setNativeExecMaxOutputForTests(null);
});

function script(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return path;
}

/** The call's message (or 'resolved: <stdout>'), or 'still running' past the deadline. */
function settle(p: Promise<string>, deadlineMs: number): Promise<string> {
  return Promise.race([
    p.then((out) => `resolved: ${out}`, (e: Error) => e.message),
    Bun.sleep(deadlineMs).then(() => 'still running'),
  ]);
}

describe.skipIf(process.platform === 'win32')('defaultExec (#893)', () => {
  test('a hung script does not hold the event loop while it runs to the bound', async () => {
    // Ignores SIGTERM too, as the #802 measurement did: only SIGKILL ends it.
    const hung = script('hung.sh', "trap '' TERM\nexec sleep 10");
    __setNativeExecTimeoutForTests(1500);
    let ticks = 0;
    const interval = setInterval(() => { ticks++; }, 20);
    try {
      // Started from a microtask, as a tool call would be: a synchronous exec
      // would block right here, before the sleep below could begin.
      const call = settle(Promise.resolve().then(() => runNative(defaultExec, [hung], '', 'osascript')), 8000);
      await Bun.sleep(1000);
      // ~50 ticks were due in that second; spawnSync allowed none (it blocked
      // before the sleep began). 10 leaves room for a loaded machine.
      const ticksWhileHung = ticks;
      expect(await call).toBe('osascript did not finish within 1.5s and was stopped');
      expect(ticksWhileHung).toBeGreaterThanOrEqual(10);
    } finally {
      clearInterval(interval);
    }
  }, 15_000);

  test('stdin reaches the script, and stdout is the answer', async () => {
    const echo = script('echo.sh', 'cat; printf " and done"');
    expect(await settle(runNative(defaultExec, [echo], '{"pid":42}', 'desktop.ps1 x'), 5000)).toBe('resolved: {"pid":42} and done');
  });

  test('an empty input still closes stdin, so a script reading it does not hang', async () => {
    const reader = script('reader.sh', 'cat >/dev/null; echo read-all');
    expect(await settle(runNative(defaultExec, [reader], '', 'desktop.ps1 x'), 5000)).toBe('resolved: read-all\n');
  });

  test('a non-zero exit throws with its stderr', async () => {
    const failing = script('fail.sh', 'echo "No visible window for PID 7" >&2; exit 1');
    expect(await settle(runNative(defaultExec, [failing], '', 'desktop.ps1 focus-window'), 5000))
      .toBe('desktop.ps1 focus-window exited with code 1: No visible window for PID 7');
  });

  test('a program that cannot start is reported as such', async () => {
    expect(await settle(runNative(defaultExec, [join(dir, 'no-such-program')], '', 'osascript'), 5000))
      .toMatch(/^osascript failed to start: /);
  });

  test('output past the cap stops the script instead of buffering without end', async () => {
    const chatty = script('chatty.sh', 'while :; do printf "%01024d" 0; done');
    __setNativeExecMaxOutputForTests(64 * 1024);
    expect(await settle(runNative(defaultExec, [chatty], '', 'desktop.ps1 capture-screen'), 5000))
      .toBe(`desktop.ps1 capture-screen was stopped: output passed ${64 * 1024} bytes`);
  });

  test('a failure keeps its stderr even when a leftover child holds the pipe (#893 review)', async () => {
    const held = script('held.sh', 'echo "boom" >&2; (sleep 3) & exit 2');
    expect(await settle(runNative(defaultExec, [held], '', 'desktop.ps1 x'), 6000)).toBe('desktop.ps1 x exited with code 2: boom');
  });

  test('a script killed by a signal is reported as killed, not as an exit code', async () => {
    const self = script('self-kill.sh', 'kill -9 $$');
    expect(await settle(runNative(defaultExec, [self], '', 'osascript'), 5000)).toBe('osascript was killed (timeout?)');
  });

  test('an answer whose pipe a leftover child keeps open is an error, never an empty answer', async () => {
    const leaky = script('leaky.sh', 'sleep 4 & echo partial');
    const started = performance.now();
    expect(await settle(runNative(defaultExec, [leaky], '', 'osascript'), 6000))
      .toBe('osascript exited with code 0 but its output never closed or could not be read');
    expect(performance.now() - started).toBeLessThan(3000);
  });
});

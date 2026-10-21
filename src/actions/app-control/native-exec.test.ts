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
import { MacAppController } from './macos.ts';
import { __setNativeExecMaxOutputForTests, __setNativeExecTimeoutForTests, defaultExec, runNative, type NativeExec } from './native-exec.ts';
import { TYPE_MS_PER_CHAR, typingAllowanceMs } from './typing-allowance.ts';
import { WindowsAppController } from './windows.ts';

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

  test('a script that exited 0 keeps its answer when a leftover child then floods stderr past the cap (#904 review)', async () => {
    // The child writes nothing to stdout, and starts its flood after the script has exited.
    const HEAD = Bun.which('head') ?? '/usr/bin/head';
    const done = script('done.sh', `echo ok; (sleep 0.2; '${HEAD}' -c 200000 /dev/zero >&2; sleep 1) >/dev/null & exit 0`);
    __setNativeExecMaxOutputForTests(64 * 1024);
    expect(await settle(runNative(defaultExec, [done], '', 'osascript'), 5000)).toBe('resolved: ok\n');
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

/**
 * #903: macOS type-text and Windows send-keys ran under the flat bound, so a
 * long text was stopped part-typed; #895 gave only Linux's xdotool type more
 * time per character. Each controller here runs the real seam against a
 * script that "types" for 1.5 s, under a 300 ms bound: 100 characters get
 * 300 + 100 x 26 ms and must finish; one character gets 326 ms and is
 * stopped, and so is a key chord, which gets no allowance.
 */
describe.skipIf(process.platform === 'win32')('typing gets more time per character on macOS and Windows too (#903)', () => {
  for (const [name, make] of [
    ['MacAppController', (exec: NativeExec) => new MacAppController({ exec })],
    ['WindowsAppController', (exec: NativeExec) => new WindowsAppController({ exec })],
  ] as const) {
    test(`${name}: a long text is not cut off at the base bound, a short one and a key chord are`, async () => {
      const typer = script(`typer-${name}.sh`, 'cat >/dev/null; exec sleep 1.5');
      // The controller's own command line, run as the fake typer instead.
      const exec: NativeExec = (_cmd, input, opts) => defaultExec([typer], input, opts);
      const ctrl = make(exec);
      __setNativeExecTimeoutForTests(300);
      // powershell.exe's path comes from %SystemRoot% (#907), which a POSIX
      // test environment lacks; the fake exec never runs it anyway.
      const savedRoot = process.env.SystemRoot;
      process.env.SystemRoot = 'D:\\Win';
      try {
        const outcome = (p: Promise<void>) => settle(p.then(() => ''), 8000);
        expect(await outcome(ctrl.typeText('x'.repeat(100)))).toBe('resolved: ');
        expect(await outcome(ctrl.typeText('x'))).toMatch(/did not finish within 0\.326s and was stopped$/);
        expect(await outcome(ctrl.pressKeys(['ctrl', 's']))).toMatch(/did not finish within 0\.3s and was stopped$/);
      } finally {
        if (savedRoot === undefined) delete process.env.SystemRoot;
        else process.env.SystemRoot = savedRoot;
      }
    }, 20_000);
  }

  test('the allowance counts characters, not UTF-16 units, and is Linux\'s measured rate', () => {
    expect(typingAllowanceMs('')).toBe(0);
    expect(typingAllowanceMs('abc')).toBe(3 * TYPE_MS_PER_CHAR);
    // One emoji is one character typed, two UTF-16 units.
    expect(typingAllowanceMs('\u{1F600}')).toBe(TYPE_MS_PER_CHAR);
    expect(TYPE_MS_PER_CHAR).toBe(26);
  });
});

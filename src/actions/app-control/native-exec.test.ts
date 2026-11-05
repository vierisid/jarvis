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
import { __setNativeExecMaxOutputForTests, __setNativeExecTimeoutForTests, defaultExec, runNative, settleNativeExec, type NativeExec, type NativeProcess } from './native-exec.ts';
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
 * #1159: a stderr flood that came while the script still ran, where the kill
 * did not land and the script then exited by itself, was reported as
 * "stopped: output passed" even for an exit 0; capture-file.ts reports the
 * script's own exit. Stand-in processes, so the order of flood, kill and exit
 * is the test's, not the scheduler's.
 */
describe('a stderr flood during the run is judged as capture-file.ts judges it (#1159)', () => {
  const CAP = 64 * 1024;
  const after = (ms: number, bytes: Uint8Array | null, head?: string) => new ReadableStream<Uint8Array>({
    start(c) { if (head) c.enqueue(new TextEncoder().encode(head)); },
    async pull(c) { await Bun.sleep(ms); if (bytes) c.enqueue(bytes); c.close(); },
  });
  /** Exits by itself with `code` at 30 ms; the kill is recorded but does not land unless `killLands`. */
  function standIn(code: number, stdout: ReadableStream<Uint8Array>, stderr: ReadableStream<Uint8Array>, killLands = false) {
    let exited = false;
    let signal: string | null = null;
    let resolveExit!: (n: number) => void;
    const exitedP = new Promise<number>((r) => { resolveExit = r; });
    void Bun.sleep(30).then(() => { if (!exited) { exited = true; resolveExit(code); } });
    const proc: NativeProcess & { kills: number } = {
      kills: 0,
      exited: exitedP,
      get exitCode() { return exited && signal === null ? code : null; },
      get signalCode() { return signal; },
      stdout, stderr,
      kill() { proc.kills++; if (killLands && !exited) { exited = true; signal = 'SIGKILL'; resolveExit(137); } },
    };
    return proc;
  }
  const run = (proc: NativeProcess) => settle(runNative((_cmd, _in, opts) => settleNativeExec(proc, opts), ['osascript'], '', 'osascript'), 5000);

  test('a script that exits 0 by itself after the flood keeps its answer', async () => {
    __setNativeExecMaxOutputForTests(CAP);
    const proc = standIn(0, after(40, new TextEncoder().encode('ok\n')), after(10, new Uint8Array(200_000)));
    expect(await run(proc)).toBe('resolved: ok\n');
    // The flood did try to stop it: the guard still fires, only the verdict follows the exit.
    expect(proc.kills).toBe(1);
  });

  test('a script that fails by itself after the flood is reported for its failure', async () => {
    __setNativeExecMaxOutputForTests(CAP);
    const proc = standIn(1, after(0, null), after(10, new Uint8Array(200_000), 'execution error'));
    expect(await run(proc)).toBe('osascript exited with code 1: execution error');
  });

  test('a flood that arrives in pipe-sized pieces is not carried whole into the error', async () => {
    __setNativeExecMaxOutputForTests(CAP);
    // Real pipes deliver the flood in pieces, each kept until the cap passes.
    let sent = 0;
    const stderr = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new TextEncoder().encode('execution error\n')); },
      async pull(c) { await Bun.sleep(1); if (sent >= 200_000) { c.close(); return; } sent += 16 * 1024; c.enqueue(new Uint8Array(16 * 1024).fill(120)); },
    });
    const proc = standIn(1, after(0, null), stderr);
    const message = await run(proc);
    expect(message.startsWith('osascript exited with code 1: execution error')).toBe(true);
    expect(message.length).toBeLessThanOrEqual('osascript exited with code 1: '.length + 500);
  });

  test('an answer that passes the cap while it is drained, after a forgiven flood, is refused', async () => {
    __setNativeExecMaxOutputForTests(CAP);
    // stderr floods at 10 ms, the kill does not land, it exits 0 at 30 ms, and
    // stdout passes the cap at 40 ms, after the exit.
    const proc = standIn(0, after(40, new Uint8Array(200_000)), after(10, new Uint8Array(200_000)));
    expect(await run(proc)).toBe(`osascript was stopped: output passed ${CAP} bytes`);
  });

  test('a flood whose kill lands is still reported as stopped', async () => {
    __setNativeExecMaxOutputForTests(CAP);
    const proc = standIn(0, after(40, new TextEncoder().encode('ok\n')), after(10, new Uint8Array(200_000)), true);
    expect(await run(proc)).toBe(`osascript was stopped: output passed ${CAP} bytes`);
  });

  test('an answer past the cap is refused even when the script exits 0 by itself', async () => {
    __setNativeExecMaxOutputForTests(CAP);
    const proc = standIn(0, after(10, new Uint8Array(200_000)), after(0, null));
    expect(await run(proc)).toBe(`osascript was stopped: output passed ${CAP} bytes`);
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

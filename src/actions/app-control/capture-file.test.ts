import { describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { __setCaptureTimeoutForTests, awaitCaptureTool, awaitCaptureToolOutput, CaptureTimeoutError, captureViaPrivateFile, captureViaPrivateFileAsync } from './capture-file.ts';
import { encodePng } from './fixtures/png.ts';
import { MacAppController } from './macos.ts';
import { __setNativeExecTimeoutForTests, defaultExec, runNative, type NativeExec } from './native-exec.ts';

/**
 * #746: every local capture wrote to a path another process could predict --
 * a millisecond timestamp in the temp directory -- and the daemon read back
 * whatever was there. Each test below pins the clock, plants a symlink at the
 * exact path the old code would have used, and checks the capture neither
 * writes through it nor reads it back.
 */

const PINNED_MS = 1_746_000_000_000 + (process.pid % 100_000);

/** A file the planted symlink points at, standing for one the daemon can write and the attacker cannot. */
function plant(predicted: string): { victim: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-746-victim-'));
  const victim = join(dir, 'victim.txt');
  writeFileSync(victim, 'untouched');
  rmSync(predicted, { force: true });
  symlinkSync(victim, predicted);
  return { victim, cleanup: () => { rmSync(predicted, { force: true }); rmSync(dir, { recursive: true, force: true }); } };
}

describe('captureViaPrivateFile (#746)', () => {
  test('hands the tool a path in a fresh private directory, and removes it after', () => {
    let seen = '';
    const bytes = captureViaPrivateFile((path) => {
      seen = path;
      const dir = statSync(dirname(path));
      expect(dir.mode & 0o777).toBe(0o700);
      expect(lstatSync(dirname(path)).isSymbolicLink()).toBe(false);
      expect(existsSync(path)).toBe(false);
      writeFileSync(path, 'image');
    });
    expect(bytes.toString()).toBe('image');
    expect(existsSync(dirname(seen))).toBe(false);
    // Two captures never share a path, whatever the clock says.
    const paths = new Set<string>();
    for (let i = 0; i < 2; i++) captureViaPrivateFile((p) => { paths.add(p); writeFileSync(p, ''); });
    expect(paths.size).toBe(2);
  });

  test('removes the directory when the tool fails, sync or async', async () => {
    let seen = '';
    expect(() => captureViaPrivateFile((p) => { seen = p; writeFileSync(p, 'half'); throw new Error('tool failed'); })).toThrow('tool failed');
    expect(existsSync(dirname(seen))).toBe(false);
    await expect(captureViaPrivateFileAsync(async (p) => { seen = p; writeFileSync(p, 'half'); throw new Error('tool failed'); })).rejects.toThrow('tool failed');
    expect(existsSync(dirname(seen))).toBe(false);
  });
});

describe('local captures do not use a predictable path (#746)', () => {
  test('macOS: screencapture is not pointed through a planted symlink', async () => {
    const realNow = Date.now;
    Date.now = () => PINNED_MS;
    const { victim, cleanup } = plant(join(tmpdir(), `jarvis-capture-${process.pid}-${PINNED_MS}.png`));
    try {
      const targets: string[] = [];
      const exec: NativeExec = (cmd) => {
        const target = cmd[cmd.length - 1]!;
        targets.push(target);
        writeFileSync(target, 'what screencapture wrote');
        return { status: 0, stdout: '', stderr: '' };
      };
      const ctrl = new MacAppController({ exec, useSidecar: false });
      const shot = await ctrl.captureScreen();
      expect(shot.toString()).toBe('what screencapture wrote');
      expect(readFileSync(victim, 'utf8')).toBe('untouched');
      expect(dirname(targets[0]!)).toStartWith(join(tmpdir(), 'jarvis-capture-'));
    } finally {
      Date.now = realNow;
      cleanup();
    }
  });

  // Linux: the capture tools are faked on PATH, in a child process, because
  // Bun's execSync and $ inherit the environment the process started with,
  // not process.env as edited since. The child also pins Date.now before the
  // code under test is loaded.
  function runChild(fakes: Record<string, string>, body: string): { exitCode: number | null; stdout: string; stderr: string; argsLog: string } {
    const bin = mkdtempSync(join(tmpdir(), 'jarvis-746-bin-'));
    try {
      const argsLog = join(bin, 'args.log');
      for (const [name, script] of Object.entries(fakes)) {
        writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> '${argsLog}'\n${script}\n`, { mode: 0o755 });
      }
      const script = `Date.now = () => ${PINNED_MS};\n${body}`;
      const child = Bun.spawnSync([process.execPath, '-e', script], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        cwd: import.meta.dir,
      });
      return { exitCode: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString(),
        argsLog: existsSync(argsLog) ? readFileSync(argsLog, 'utf8') : '' };
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  }

  // The last argument is the output path for scrot and import alike.
  const WRITE_LAST_ARG = 'for last; do :; done\nprintf "what the tool wrote" > "$last"';

  test.skipIf(process.platform !== 'linux')('capture_screen: scrot is not pointed through a planted symlink', () => {
    const { victim, cleanup } = plant(`/tmp/jarvis-screenshot-${PINNED_MS}.png`);
    try {
      const builtin = join(import.meta.dir, '..', 'tools', 'builtin.ts');
      const out = runChild({ scrot: WRITE_LAST_ARG }, `
        const { captureScreenTool } = await import(${JSON.stringify(builtin)});
        process.stdout.write(JSON.stringify(await captureScreenTool.execute({})));`);
      expect({ exitCode: out.exitCode, stderr: out.stderr }).toMatchObject({ exitCode: 0 });
      expect(readFileSync(victim, 'utf8')).toBe('untouched');
      expect(out.argsLog).toContain(join(tmpdir(), 'jarvis-capture-'));
      // What the tool wrote is what came back, not what the symlink points at.
      const result = JSON.parse(out.stdout) as { content: Array<{ source?: { data: string } }> };
      expect(Buffer.from(result.content[1]!.source!.data, 'base64').toString()).toBe('what the tool wrote');
    } finally {
      cleanup();
    }
  });

  test.skipIf(process.platform !== 'linux')('Linux controller: captureScreen and captureWindow are not pointed through planted symlinks', () => {
    const screen = plant(`/tmp/jarvis-screen-${PINNED_MS}.png`);
    const window = plant(`/tmp/jarvis-window-4242-${PINNED_MS}.png`);
    try {
      const linux = join(import.meta.dir, 'linux.ts');
      const out = runChild({
        import: WRITE_LAST_ARG,
        xdotool: 'echo 77',
        xprop: 'echo "_NET_WM_PID(CARDINAL) = 4242"',
      }, `
        const { LinuxAppController } = await import(${JSON.stringify(linux)});
        const ctrl = new LinuxAppController();
        const a = await ctrl.captureScreen();
        const b = await ctrl.captureWindow(4242);
        process.stdout.write(JSON.stringify([a.toString(), b.toString()]));`);
      expect({ exitCode: out.exitCode, stderr: out.stderr }).toMatchObject({ exitCode: 0 });
      expect(JSON.parse(out.stdout)).toEqual(['what the tool wrote', 'what the tool wrote']);
      expect(readFileSync(screen.victim, 'utf8')).toBe('untouched');
      expect(readFileSync(window.victim, 'utf8')).toBe('untouched');
      const importCalls = out.argsLog.split('\n').filter((l) => l.startsWith('import '));
      expect(importCalls).toHaveLength(2);
      for (const call of importCalls) expect(call).toContain(join(tmpdir(), 'jarvis-capture-'));
    } finally {
      screen.cleanup();
      window.cleanup();
    }
  });

  /**
   * #802: the capture tools ran with no bound. Each fake below hangs and
   * ignores SIGTERM -- the shape a tool stuck on a wedged display server
   * takes -- for 5 s, so a run that is not stopped still ends, but late. The
   * bound is shortened to 300 ms through the test seam.
   */
  const HANG = "trap '' TERM\nexec sleep 5";

  function runChildWithBound(fakes: Record<string, string>, body: string) {
    const captureFile = join(import.meta.dir, 'capture-file.ts');
    return runChild(fakes, `
      const { __setCaptureTimeoutForTests } = await import(${JSON.stringify(captureFile)});
      __setCaptureTimeoutForTests?.(300);
      // Ticks while the capture runs: a synchronous spawn allows none.
      let ticks = 0;
      const iv = setInterval(() => ticks++, 10);
      const started = performance.now();
      const result = await (async () => { ${body} })();
      clearInterval(iv);
      process.stdout.write(JSON.stringify({ result, ms: Math.round(performance.now() - started), ticks }));`);
  }

  test.skipIf(process.platform !== 'linux')('#802 capture_screen: a hung scrot is stopped, without holding the event loop or trying import', () => {
    const builtin = join(import.meta.dir, '..', 'tools', 'builtin.ts');
    const out = runChildWithBound({ scrot: HANG, import: WRITE_LAST_ARG }, `
      const { captureScreenTool } = await import(${JSON.stringify(builtin)});
      return captureScreenTool.execute({});`);
    expect({ exitCode: out.exitCode, stderr: out.stderr }).toMatchObject({ exitCode: 0 });
    const { result, ms, ticks } = JSON.parse(out.stdout) as { result: string; ms: number; ticks: number };
    expect(result).toBe('Error capturing screen: scrot did not finish within 0.3s and was stopped');
    expect(ms).toBeLessThan(3000);
    // ~30 at 10 ms over 300 ms; a blocked loop gets none in.
    expect(ticks).toBeGreaterThan(5);
    expect(out.argsLog).not.toContain('import ');
  }, 30_000);

  test.skipIf(process.platform !== 'linux')('#802 Linux controller: a hung import is stopped in captureScreen and captureWindow', () => {
    const linux = join(import.meta.dir, 'linux.ts');
    const out = runChildWithBound({
      import: HANG,
      xdotool: 'echo 77',
      xprop: 'echo "_NET_WM_PID(CARDINAL) = 4242"',
    }, `
      const { LinuxAppController } = await import(${JSON.stringify(linux)});
      const ctrl = new LinuxAppController();
      const outcome = (p) => p.then(() => 'captured', (e) => e.message);
      return [await outcome(ctrl.captureScreen()), await outcome(ctrl.captureWindow(4242))];`);
    expect({ exitCode: out.exitCode, stderr: out.stderr }).toMatchObject({ exitCode: 0 });
    const { result, ms } = JSON.parse(out.stdout) as { result: string[]; ms: number };
    expect(result).toEqual([
      'Failed to capture screen: import did not finish within 0.3s and was stopped',
      'Failed to capture window: import did not finish within 0.3s and was stopped',
    ]);
    expect(ms).toBeLessThan(5000);
  }, 30_000);

  // The window lookups captureWindow runs first talk to the same X server.
  for (const [hung, others] of [
    ['xdotool', { xprop: 'echo "_NET_WM_PID(CARDINAL) = 4242"' }],
    ['xprop', { xdotool: 'printf "77\\n78\\n79\\n"' }],
  ] as const) {
    test.skipIf(process.platform !== 'linux')(`#802 Linux controller: a hung ${hung} in the window lookup is stopped once, not once per window`, () => {
      const linux = join(import.meta.dir, 'linux.ts');
      const out = runChildWithBound({ [hung]: HANG, ...others, import: WRITE_LAST_ARG }, `
        const { LinuxAppController } = await import(${JSON.stringify(linux)});
        return new LinuxAppController().captureWindow(4242).then(() => 'captured', (e) => e.message);`);
      expect({ exitCode: out.exitCode, stderr: out.stderr }).toMatchObject({ exitCode: 0 });
      const { result } = JSON.parse(out.stdout) as { result: string };
      expect(result).toBe(`Failed to capture window: ${hung === 'xdotool' ? 'xdotool search' : 'xprop'} did not finish within 0.3s and was stopped`);
      // Three windows: a lookup that skipped a hung xprop would run it, and
      // pay the bound, three times.
      expect(out.argsLog.split('\n').filter((l) => l.startsWith(`${hung} `))).toHaveLength(1);
      expect(out.argsLog).not.toContain('import ');
    }, 30_000);
  }

  // #803: the compaction queue raises a canceled run's fence, and capture_screen
  // used to turn every throw into an "Error capturing screen" string.
  test.skipIf(process.platform !== 'linux')('#803 capture_screen: a canceled run\'s fence leaves the tool as the cancellation itself', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jarvis-803-'));
    try {
      // Wider than MAX_IMAGE_SIDE, so it goes through the compaction queue.
      const wide = join(dir, 'wide.png');
      writeFileSync(wide, encodePng(8001, 1, 2, 8, [new Uint8Array(8001 * 3)]));
      const builtin = join(import.meta.dir, '..', 'tools', 'builtin.ts');
      const scope = join(import.meta.dir, '..', 'execution-scope.ts');
      const errors = join(import.meta.dir, '..', '..', 'workflows', 'runtime', 'cancellation-error.ts');
      const out = runChild({ scrot: `for last; do :; done\ncp '${wide}' "$last"` }, `
        const { captureScreenTool } = await import(${JSON.stringify(builtin)});
        const { withExecutionScope } = await import(${JSON.stringify(scope)});
        const { WorkflowCancellationError } = await import(${JSON.stringify(errors)});
        const ok = await withExecutionScope(() => {}, () => captureScreenTool.execute({}));
        const canceled = await withExecutionScope(() => { throw new WorkflowCancellationError('run-803'); },
          () => captureScreenTool.execute({})).then((r) => ({ returned: r }), (e) => ({ threw: e?.constructor?.name }));
        process.stdout.write(JSON.stringify({ ok: JSON.stringify(ok).includes('image/jpeg'), canceled }));`);
      expect({ exitCode: out.exitCode, stderr: out.stderr }).toMatchObject({ exitCode: 0 });
      expect(JSON.parse(out.stdout)).toEqual({ ok: true, canceled: { threw: 'WorkflowCancellationError' } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('capture tool bounds (#802)', () => {
  /** A stand-in process: `exited` settles only when the test says, so timing is the test's. */
  function fakeProc(opts: { exitCode?: number | null; signalCode?: string | null; neverExits?: boolean }) {
    let kills = 0;
    const empty = () => new ReadableStream<Uint8Array>({ start(c) { c.close(); } });
    return {
      exited: opts.neverExits ? new Promise<number>(() => {}) : Bun.sleep(400).then(() => 0),
      exitCode: opts.exitCode ?? null,
      signalCode: opts.signalCode ?? null,
      stderr: empty(),
      stdout: empty(),
      kill: () => { kills++; },
      kills: () => kills,
    };
  }

  test('a tool whose exit never comes back after the kill is given up on after a short grace', async () => {
    __setCaptureTimeoutForTests(100);
    try {
      const proc = fakeProc({ neverExits: true });
      const started = performance.now();
      const outcome = await Promise.race([
        awaitCaptureTool(proc, 'scrot').then(() => 'returned', (e: unknown) => e),
        Bun.sleep(4000).then(() => 'still waiting'),
      ]);
      expect(outcome).toBeInstanceOf(CaptureTimeoutError);
      expect(proc.kills()).toBe(1);
      // The bound plus the 1 s grace, not the 4 s this waited.
      expect(performance.now() - started).toBeLessThan(2500);
    } finally {
      __setCaptureTimeoutForTests(null);
    }
  });

  for (const ended of [{ exitCode: 0 }, { signalCode: 'SIGSEGV' }]) {
    test(`a tool that already ${'exitCode' in ended ? 'exited' : 'crashed'} when the bound passes is not killed or called a timeout`, async () => {
      __setCaptureTimeoutForTests(100);
      try {
        const proc = fakeProc(ended);
        await expect(awaitCaptureTool(proc, 'scrot')).resolves.toBeUndefined();
        expect(proc.kills()).toBe(0);
      } finally {
        __setCaptureTimeoutForTests(null);
      }
    });
  }

  test('a lookup whose output a leftover child keeps open is a timeout, never an empty answer', async () => {
    // sh exits at once; the backgrounded sleep keeps stdout open for 3 s.
    const proc = Bun.spawn(['sh', '-c', 'sleep 3 & echo 77'], { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' });
    const started = performance.now();
    await expect(awaitCaptureToolOutput(proc as never, 'xdotool search')).rejects.toThrow('xdotool search exited but its output never closed');
    expect(performance.now() - started).toBeLessThan(2000);
  });

  test('a capture tool that fails is reported with its exit code and stderr', async () => {
    const proc = Bun.spawn(['sh', '-c', 'echo "cannot open display" >&2; exit 3'], { stdout: 'ignore', stderr: 'pipe' });
    await expect(awaitCaptureTool(proc, 'scrot')).rejects.toThrow('scrot exited with code 3: cannot open display');
  });

  test('macOS/Windows seam: a script that ignores SIGTERM is still stopped at the bound', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jarvis-802-'));
    const hung = join(dir, 'hung.sh');
    writeFileSync(hung, "#!/bin/sh\ntrap '' TERM\nexec sleep 5\n", { mode: 0o755 });
    __setNativeExecTimeoutForTests(300);
    try {
      const started = performance.now();
      expect(() => runNative(defaultExec, [hung], '', 'screencapture')).toThrow('screencapture did not finish within 0.3s and was stopped');
      expect(performance.now() - started).toBeLessThan(3000);
    } finally {
      __setNativeExecTimeoutForTests(null);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

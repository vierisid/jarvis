import { describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { captureViaPrivateFile, captureViaPrivateFileAsync } from './capture-file.ts';
import { MacAppController } from './macos.ts';
import type { NativeExec } from './native-exec.ts';

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
});

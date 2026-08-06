import { test, expect, describe } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MacAppController, mapMacKeys } from './macos.ts';
import type { NativeExec, NativeExecResult } from './native-exec.ts';

const SCRIPT_PATH = join(import.meta.dir, 'scripts', 'desktop.applescript');

type Call = { cmd: string[]; input: string };

function fakeExec(handler: (cmd: string[], input: string) => Partial<NativeExecResult>) {
  const calls: Call[] = [];
  const exec: NativeExec = (cmd, input) => {
    calls.push({ cmd, input });
    const result = handler(cmd, input);
    return { status: 0, stdout: '', stderr: '', ...result };
  };
  return { exec, calls };
}

function controller(handler: (cmd: string[], input: string) => Partial<NativeExecResult>) {
  const { exec, calls } = fakeExec(handler);
  return { ctrl: new MacAppController({ exec, useSidecar: false }), calls };
}

// pid, focused, x, y, width, height, className, title
const windowLine = (pid: number, focused: boolean, title: string) =>
  `${pid}\t${focused ? '1' : '0'}\t10\t20\t300\t200\tSafari\t${title}`;

describe('mapMacKeys', () => {
  test('maps named keys to virtual key codes, not keystroke text', () => {
    // Regression: PR #279 generated `keystroke "return"`, which types the word.
    expect(mapMacKeys(['Enter'])).toEqual({ modifiers: [], kind: 'code', value: '36' });
    expect(mapMacKeys(['Tab'])).toEqual({ modifiers: [], kind: 'code', value: '48' });
    expect(mapMacKeys(['Escape'])).toEqual({ modifiers: [], kind: 'code', value: '53' });
  });

  test('collects modifiers into a chord', () => {
    expect(mapMacKeys(['Command', 'A'])).toEqual({ modifiers: ['command'], kind: 'char', value: 'a' });
    expect(mapMacKeys(['Ctrl', 'Shift', 'Tab'])).toEqual({ modifiers: ['control', 'shift'], kind: 'code', value: '48' });
    expect(mapMacKeys(['Alt', 'Left'])).toEqual({ modifiers: ['option'], kind: 'code', value: '123' });
  });

  test('rejects chords without a main key or with several main keys', () => {
    expect(() => mapMacKeys(['Command'])).toThrow(/no non-modifier key/);
    expect(() => mapMacKeys(['A', 'B'])).toThrow(/more than one non-modifier key/);
    expect(() => mapMacKeys(['Widget'])).toThrow(/Unsupported key/);
  });
});

describe('MacAppController fallback', () => {
  test('runs the fixed script asset with the command as an argument', async () => {
    const { ctrl, calls } = controller(() => ({ stdout: windowLine(42, true, 'Docs') }));
    await ctrl.getActiveWindow();
    expect(calls[0]!.cmd.slice(0, 3)).toEqual(['osascript', SCRIPT_PATH, 'get-active-window']);
  });

  test('getActiveWindow parses the tab-separated line', async () => {
    const { ctrl } = controller(() => ({ stdout: windowLine(42, true, 'Docs — Draft') }));
    expect(await ctrl.getActiveWindow()).toEqual({
      pid: 42,
      title: 'Docs — Draft',
      className: 'Safari',
      bounds: { x: 10, y: 20, width: 300, height: 200 },
      focused: true,
    });
  });

  test('listWindows parses multiple lines and skips malformed ones', async () => {
    const out = [windowLine(1, true, 'A'), 'garbage', windowLine(2, false, 'B')].join('\n');
    const { ctrl } = controller(() => ({ stdout: out }));
    const windows = await ctrl.listWindows();
    expect(windows.map((w) => w.pid)).toEqual([1, 2]);
    expect(windows[1]!.focused).toBe(false);
  });

  test('typeText passes user text as a standalone argv item, unmodified', async () => {
    // Regression: PR #279 spliced text into AppleScript source.
    const hostile = `he said "hi" & 'bye' \\ $(reboot) \n newline`;
    const { ctrl, calls } = controller(() => ({}));
    await ctrl.typeText(hostile);
    expect(calls[0]!.cmd).toEqual(['osascript', SCRIPT_PATH, 'type-text', hostile]);
  });

  test('pressKeys sends mapped chord arguments, never raw AppleScript', async () => {
    const { ctrl, calls } = controller(() => ({}));
    await ctrl.pressKeys(['Command', 'Shift', 'Enter']);
    expect(calls[0]!.cmd).toEqual(['osascript', SCRIPT_PATH, 'press-keys', 'command,shift', 'code', '36']);
    await ctrl.pressKeys(['Enter']);
    expect(calls[1]!.cmd).toEqual(['osascript', SCRIPT_PATH, 'press-keys', '-', 'code', '36']);
  });

  test('clickElement clicks at the element center', async () => {
    const { ctrl, calls } = controller(() => ({}));
    await ctrl.clickElement({
      id: '1', role: 'button', name: 'OK', value: null,
      bounds: { x: 100, y: 100, width: 51, height: 21 }, children: [], properties: {},
    });
    expect(calls[0]!.cmd).toEqual(['osascript', SCRIPT_PATH, 'click-at', '126', '111']);
  });

  test('captureWindow captures the region of the window matching the pid', async () => {
    const png = Buffer.from('fake-png');
    const { ctrl, calls } = controller((cmd) => {
      if (cmd[0] === 'osascript') return { stdout: windowLine(42, true, 'Docs') };
      // screencapture: write the "image" to the target file (last arg)
      writeFileSync(cmd[cmd.length - 1]!, png);
      return {};
    });
    const buffer = await ctrl.captureWindow(42);
    const capture = calls.find((c) => c.cmd[0] === 'screencapture')!;
    expect(capture.cmd).toContain('-R');
    expect(capture.cmd).toContain('10,20,300,200');
    expect(buffer.equals(png)).toBe(true);
    // Temp file is cleaned up
    expect(existsSync(capture.cmd[capture.cmd.length - 1]!)).toBe(false);
  });

  test('throws with stderr detail when osascript exits non-zero', async () => {
    // Regression: PR #279 swallowed stderr and returned '' on failure.
    const { ctrl } = controller(() => ({
      status: 1,
      stderr: 'execution error: Can’t get application process whose unix id = 7. (-1728)',
    }));
    expect(ctrl.focusWindow(7)).rejects.toThrow(/unix id = 7/);
  });

  test('launchApp uses open with an argv array, never a shell string', async () => {
    // Regression: PR #279 built `sh -c` with unescaped executable/args.
    const { ctrl, calls } = controller(() => ({}));
    await ctrl.launchApp(`App'; reboot; '`, '--flag "a b"');
    const cmd = calls[0]!.cmd;
    expect(cmd[0]).toBe('open');
    expect(cmd).toEqual(['open', '-a', `App'; reboot; '`, '--args', '--flag', 'a b']);
  });

  test('launchApp path-fallback keeps the arguments', async () => {
    // Regression (review): the retry after a failed `open -a` dropped --args.
    const { ctrl, calls } = controller((cmd) =>
      cmd[1] === '-a' ? { status: 1, stderr: 'Unable to find application' } : {},
    );
    await ctrl.launchApp('/opt/tool.app', '--flag');
    expect(calls[1]!.cmd).toEqual(['open', '/opt/tool.app', '--args', '--flag']);
  });

  test('closeWindow and getWindowTree without sidecar throw instead of pretending', async () => {
    const { ctrl } = controller(() => ({}));
    expect(ctrl.closeWindow(1)).rejects.toThrow(/sidecar/);
    expect(ctrl.getWindowTree(1)).rejects.toThrow(/sidecar/);
  });
});

describe('desktop.applescript script asset', () => {
  const script = readFileSync(SCRIPT_PATH, 'utf-8');

  test('dispatches through on run argv (no source assembly)', () => {
    expect(script).toContain('on run argv');
  });

  test('does not depend on binaries that do not ship with macOS', () => {
    // Regression: PR #279 relied on cliclick / mouseclick.
    expect(script).not.toContain('cliclick');
    expect(script).not.toContain('mouseclick');
  });

  test('never types key names as literal text', () => {
    // Regression: PR #279 generated `keystroke "return"`.
    expect(script).not.toMatch(/keystroke "(return|tab|escape|delete|space)"/);
    expect(script).toContain('key code (keyValue as integer)');
  });

  test('avoids System Events dictionary terms as identifiers in tell blocks', () => {
    // Regression (review): a pressKeys parameter named `kind` collided with
    // System Events terminology, breaking every press-keys invocation.
    expect(script).toContain('on pressKeys(modsCsv, keyKind, keyValue)');
    expect(script).toContain('set useCode to (keyKind is "code")');
    // The CI probe command exercises the terminology-sensitive constructs.
    expect(script).toContain('on probeTerminology()');
  });

  test('sanitizes tabs/newlines in titles and process names', () => {
    // Regression (review): un-sanitized fields break the tab-separated,
    // line-per-window format (the ps1 side already squashed them).
    expect(script).toContain('on sanitizeField(theValue)');
    expect(script).toContain('my sanitizeField(winTitle)');
    expect(script).toContain('my sanitizeField(procName)');
  });

  test('coerces numeric window fields to text before concatenation', () => {
    // Regression: PR #279 concatenated integers with &, producing AppleScript
    // list concatenation and corrupted window metadata.
    expect(script).toContain('(procPid as text) & tab');
    expect(script).toContain('(xPos as text)');
  });

  const hasOsacompile = spawnSync('which', ['osacompile'], { encoding: 'utf-8', timeout: 10_000 }).status === 0;

  // Only runs on macOS dev machines; proves the script compiles. CI runs the
  // same checks in the applescript-check job of test.yml.
  test.skipIf(!hasOsacompile)('compiles under osacompile', () => {
    const out = join(tmpdir(), `jarvis-desktop-syntax-${process.pid}.scpt`);
    try {
      const result = spawnSync('osacompile', ['-o', out, SCRIPT_PATH], { encoding: 'utf-8', timeout: 60_000 });
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
    } finally {
      try { unlinkSync(out); } catch {}
    }
  }, 60_000);

  // Executes the event-free probe command on the real interpreter, catching
  // runtime terminology collisions that osacompile accepts.
  test.skipIf(!hasOsacompile)('terminology probe runs on the real interpreter', () => {
    const result = spawnSync('osascript', [SCRIPT_PATH, 'probe'], { encoding: 'utf-8', timeout: 60_000 });
    expect(result.stderr).toBe('');
    expect(result.stdout.trim()).toBe('mods=2;code=36');
    expect(result.status).toBe(0);
  }, 60_000);
});

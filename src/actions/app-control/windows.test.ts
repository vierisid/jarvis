import { test, expect, describe } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WindowsAppController, escapeSendKeysText, mapKeysToSendKeys, toAsciiJson } from './windows.ts';
import type { NativeExec, NativeExecResult } from './native-exec.ts';

const SCRIPT_PATH = join(import.meta.dir, 'scripts', 'desktop.ps1');

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
  return { ctrl: new WindowsAppController({ exec, useSidecar: false }), calls };
}

describe('escapeSendKeysText', () => {
  test('escapes SendKeys metacharacters by wrapping in braces', () => {
    expect(escapeSendKeysText('100%+{cool}')).toBe('100{%}{+}{{}cool{}}');
    expect(escapeSendKeysText('a^b~c(d)e')).toBe('a{^}b{~}c{(}d{)}e');
    expect(escapeSendKeysText('[x]')).toBe('{[}x{]}');
  });

  test('leaves exclamation marks untouched', () => {
    // Regression: PR #279 replaced "!" with the literal string " Surround EscapeExclamation".
    expect(escapeSendKeysText('hello world!')).toBe('hello world!');
  });

  test('converts newlines and tabs to key tokens', () => {
    expect(escapeSendKeysText('a\nb\r\nc\td')).toBe('a{ENTER}b{ENTER}c{TAB}d');
  });
});

describe('mapKeysToSendKeys', () => {
  test('maps modifier chords', () => {
    expect(mapKeysToSendKeys(['Control', 'C'])).toBe('^c');
    expect(mapKeysToSendKeys(['Control', 'Shift', 'S'])).toBe('^+s');
    expect(mapKeysToSendKeys(['Alt', 'Tab'])).toBe('%{TAB}');
  });

  test('maps named keys', () => {
    expect(mapKeysToSendKeys(['Enter'])).toBe('{ENTER}');
    expect(mapKeysToSendKeys(['Escape'])).toBe('{ESC}');
    expect(mapKeysToSendKeys(['F5'])).toBe('{F5}');
  });

  test('escapes special single-character keys', () => {
    expect(mapKeysToSendKeys(['Control', '+'])).toBe('^{+}');
  });

  test('rejects the Windows key and unknown keys', () => {
    expect(() => mapKeysToSendKeys(['Win', 'L'])).toThrow(/sidecar/);
    expect(() => mapKeysToSendKeys(['NotAKey'])).toThrow(/Unsupported key/);
    expect(() => mapKeysToSendKeys(['Control'])).toThrow(/no non-modifier key/);
  });

  test('rejects multiple non-modifier keys, matching macOS/Linux chord semantics', () => {
    expect(() => mapKeysToSendKeys(['A', 'B'])).toThrow(/more than one non-modifier key/);
  });
});

describe('toAsciiJson', () => {
  test('escapes all non-ASCII characters while round-tripping via JSON', () => {
    const payload = { keys: 'café — “smart” ünïcode ✓' };
    const json = toAsciiJson(payload);
    for (const ch of json) {
      expect(ch.charCodeAt(0)).toBeLessThan(128);
    }
    expect(JSON.parse(json)).toEqual(payload);
  });
});

describe('WindowsAppController fallback', () => {
  const windowJson = JSON.stringify({
    pid: 123, focused: true, x: 10, y: 20, width: 300, height: 200,
    className: 'Chrome_WidgetWin_1', title: 'Docs',
  });

  test('invokes the fixed script asset by path, never -Command', async () => {
    const { ctrl, calls } = controller(() => ({ stdout: windowJson }));
    await ctrl.getActiveWindow();
    const cmd = calls[0]!.cmd;
    expect(cmd[0]).toBe('powershell.exe');
    expect(cmd).toContain('-File');
    expect(cmd).toContain(SCRIPT_PATH);
    expect(cmd).toContain('get-active-window');
    expect(cmd).not.toContain('-Command');
  });

  test('getActiveWindow parses the script JSON', async () => {
    const { ctrl } = controller(() => ({ stdout: windowJson }));
    const win = await ctrl.getActiveWindow();
    expect(win).toEqual({
      pid: 123,
      title: 'Docs',
      className: 'Chrome_WidgetWin_1',
      bounds: { x: 10, y: 20, width: 300, height: 200 },
      focused: true,
    });
  });

  test('listWindows handles both array and single-object JSON', async () => {
    const { ctrl: many } = controller(() => ({ stdout: `[${windowJson},${windowJson}]` }));
    expect(await many.listWindows()).toHaveLength(2);
    const { ctrl: one } = controller(() => ({ stdout: windowJson }));
    expect(await one.listWindows()).toHaveLength(1);
  });

  test('typeText sends user text only via stdin JSON, never on the command line', async () => {
    // Regression: PR #279 interpolated text into single-quoted PowerShell.
    const hostile = `'; Start-Process calc; '$(rm -rf /) "double" \`backtick\``;
    const { ctrl, calls } = controller(() => ({}));
    await ctrl.typeText(hostile);
    const call = calls[0]!;
    expect(call.cmd.join(' ')).not.toContain('Start-Process');
    const payload = JSON.parse(call.input) as { keys: string };
    expect(payload.keys).toBe(escapeSendKeysText(hostile));
  });

  test('typeText payload is ASCII-safe for the OEM-code-page stdin', async () => {
    // Regression: powershell.exe decodes redirected stdin with the OEM code
    // page, so raw UTF-8 payloads arrive as mojibake.
    const { ctrl, calls } = controller(() => ({}));
    await ctrl.typeText('café ünïcode ✓');
    const input = calls[0]!.input;
    for (const ch of input) {
      expect(ch.charCodeAt(0)).toBeLessThan(128);
    }
    expect((JSON.parse(input) as { keys: string }).keys).toBe('café ünïcode ✓');
  });

  test('clickElement clicks at the element center via click-at', async () => {
    // Regression: PR #279 sent SendKeys "{CLICK}", which is not a SendKeys token.
    const { ctrl, calls } = controller(() => ({}));
    await ctrl.clickElement({
      id: '1', role: 'button', name: 'OK', value: null,
      bounds: { x: 100, y: 100, width: 51, height: 21 }, children: [], properties: {},
    });
    expect(calls[0]!.cmd).toContain('click-at');
    expect(JSON.parse(calls[0]!.input)).toEqual({ x: 126, y: 111 });
  });

  test('captureWindow passes the pid to the script', async () => {
    // Regression: PR #279 ignored the pid and always captured the full screen.
    const png = Buffer.from('fake-png');
    const { ctrl, calls } = controller(() => ({ stdout: png.toString('base64') }));
    const buffer = await ctrl.captureWindow(4242);
    expect(calls[0]!.cmd).toContain('capture-window');
    expect(JSON.parse(calls[0]!.input)).toEqual({ pid: 4242 });
    expect(buffer.equals(png)).toBe(true);
  });

  test('throws with stderr detail when the script exits non-zero', async () => {
    // Regression: PR #279 swallowed failures and returned empty strings.
    const { ctrl } = controller(() => ({ status: 1, stderr: 'No visible window for PID 7' }));
    expect(ctrl.focusWindow(7)).rejects.toThrow(/No visible window for PID 7/);
  });

  test('throws when the process cannot be spawned', async () => {
    const { ctrl } = controller(() => ({ status: null, error: new Error('ENOENT') }));
    expect(ctrl.captureScreen()).rejects.toThrow(/failed to start: ENOENT/);
  });

  test('launchApp passes executable and args via stdin payload', async () => {
    const { ctrl, calls } = controller(() => ({ stdout: '{"pid":555}' }));
    const result = await ctrl.launchApp(`C:\\Program Files\\O'Brien\\app.exe`, '--flag "a b"');
    expect(calls[0]!.cmd).toContain('launch-app');
    expect(JSON.parse(calls[0]!.input)).toEqual({
      executable: `C:\\Program Files\\O'Brien\\app.exe`,
      args: '--flag "a b"',
    });
    expect(result).toEqual({ pid: 555, executable: `C:\\Program Files\\O'Brien\\app.exe`, args: '--flag "a b"' });
  });

  test('getWindowTree without sidecar throws instead of pretending', async () => {
    const { ctrl } = controller(() => ({}));
    expect(ctrl.getWindowTree(1)).rejects.toThrow(/sidecar/);
  });
});

describe('desktop.ps1 script asset', () => {
  const script = readFileSync(SCRIPT_PATH, 'utf-8');

  test('never starts a line with a pipe (PowerShell 5.1 parse error)', () => {
    // Regression: PR #279 emitted "| ConvertTo-Json" on its own line.
    expect(script).not.toMatch(/^\s*\|/m);
  });

  test('never assigns to the read-only $pid automatic variable', () => {
    expect(script).not.toMatch(/\$pid\s*=/i);
    expect(script).not.toMatch(/\[ref\]\s*\$pid\b/i);
  });

  test('does not use SendKeys mouse-click pseudo-tokens', () => {
    expect(script).not.toContain('{CLICK}');
  });

  test('keeps System.Drawing out of the compiled C# (needs -ReferencedAssemblies)', () => {
    // Regression: PR #279 compiled C# referencing System.Drawing/WinForms
    // without -ReferencedAssemblies. Drawing is only used from PowerShell
    // after Add-Type -AssemblyName.
    expect(script).not.toMatch(/using System\.Drawing/);
    expect(script).not.toMatch(/using System\.Windows\.Forms/);
    expect(script).toContain('Add-Type -AssemblyName System.Drawing');
  });

  test('reads payloads from stdin and reports failures on stderr with exit 1', () => {
    expect(script).toContain('[Console]::In.ReadToEnd()');
    expect(script).toContain('[Console]::Error.WriteLine');
    expect(script).toContain('exit 1');
  });

  const hasPwsh = spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], {
    encoding: 'utf-8', timeout: 30_000,
  }).status === 0;

  // pwsh is preinstalled on GitHub ubuntu runners, so this runs in CI.
  // Executing with an unknown command proves the script parses, the C#
  // interop block compiles, and the error path exits 1 via stderr.
  test.skipIf(!hasPwsh)('parses and compiles under pwsh', () => {
    const result = spawnSync(
      'pwsh',
      ['-NoProfile', '-NonInteractive', '-File', SCRIPT_PATH, 'syntax-probe'],
      { encoding: 'utf-8', input: '', timeout: 120_000 },
    );
    expect(result.stderr).toContain('Unknown command: syntax-probe');
    expect(result.status).toBe(1);
  }, 120_000);
});

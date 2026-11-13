import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { appOpenNeedsNoApproval, ownerAskedOnNotch, plainAppOpen } from './app-open.ts';
import { approvalDecidableBy, DASHBOARD_DECIDER, NOTCH_DECIDER } from './approval.ts';
import { rawUiGate } from './ui-intent.ts';
import { resolveToolGate } from './tool-action-map.ts';
import { withBriefTurn } from '../brief/chat-context.ts';
import { NOTCH_SWITCH } from '../notch/switch.ts';

let before: string | undefined;
beforeEach(() => { before = process.env[NOTCH_SWITCH]; process.env[NOTCH_SWITCH] = '1'; });
afterEach(() => { if (before === undefined) delete process.env[NOTCH_SWITCH]; else process.env[NOTCH_SWITCH] = before; });

const open = (executable: unknown, args?: unknown): Record<string, unknown> => ({ executable, ...(args === undefined ? {} : { args }) });
/** Runs `fn` inside a turn whose request id is `requestId`. */
const inTurn = <T>(requestId: string, fn: () => T): T =>
  withBriefTurn({ conversationId: 'c', turnId: 't', requestId, signal: new AbortController().signal, progress: () => {} }, fn);

describe('what a plain app open is', () => {
  test('an app named the way a person names one, or installed where apps are installed', () => {
    for (const executable of ['steam', 'steam.exe', 'notepad', 'Spotify', 'Google Chrome', 'TextEdit', 'calc',
      'C:\\Program Files (x86)\\Steam\\steam.exe', 'C:\\Program Files\\Mozilla Firefox\\firefox.exe', 'D:\\Program Files\\Game\\game.exe',
      '/Applications/Safari.app', '/System/Applications/Calculator.app']) {
      expect([executable, plainAppOpen('desktop_launch_app', open(executable))]).toEqual([executable, true]);
    }
  });

  test('never with arguments: an app that is told what to do is a command', () => {
    expect(plainAppOpen('desktop_launch_app', open('steam', '-applaunch 730'))).toBe(false);
    expect(plainAppOpen('desktop_launch_app', open('notepad', 'C:\\secret.txt'))).toBe(false);
    expect(plainAppOpen('desktop_launch_app', open('steam', ''))).toBe(true);
  });

  test('never a shell, a script host, an installer or a tool that acts by being started', () => {
    for (const executable of ['cmd', 'cmd.exe', 'powershell', 'PowerShell.exe', 'pwsh', 'wscript', 'mshta', 'rundll32', 'msiexec', 'python',
      'node', 'bash', 'wsl', 'logoff', 'shutdown', 'regedit', 'terminal', 'osascript', 'curl',
      'C:\\Program Files\\PowerShell\\7\\pwsh.exe', '/Applications/Terminal.app']) {
      expect([executable, plainAppOpen('desktop_launch_app', open(executable))]).toEqual([executable, false]);
    }
  });

  test('never a script, an installer or a shortcut, whatever it is called', () => {
    for (const executable of ['update.bat', 'setup.msi', 'run.ps1', 'thing.vbs', 'Steam.lnk', 'game.scr', 'tool.jar', 'x.cmd']) {
      expect([executable, plainAppOpen('desktop_launch_app', open(executable))]).toEqual([executable, false]);
    }
  });

  test('never a program from somewhere else on the disk', () => {
    for (const executable of ['C:\\Users\\sam\\Downloads\\steam.exe', 'C:\\Temp\\a.exe', 'C:\\Program Files\\..\\Users\\sam\\a.exe',
      '\\\\server\\share\\steam.exe', '/tmp/steam', '/Users/sam/Downloads/Safari.app', 'C:\\Windows\\System32\\notepad.exe',
      'C:\\Program Files\\App\\app.dll']) {
      expect([executable, plainAppOpen('desktop_launch_app', open(executable))]).toEqual([executable, false]);
    }
  });

  test('never something a shell would read, or nothing at all', () => {
    for (const executable of ['steam & del x', 'steam; rm -rf ~', 'steam | x', '$(steam)', '`steam`', 'steam\nnotepad', '%COMSPEC%', '', '   ', 7, null,
      'steam://run/730', 'https://example.com', 'ms-settings:', 'mailto:sam@example.com', "it's"]) {
      expect(plainAppOpen('desktop_launch_app', open(executable))).toBe(false);
    }
  });

  test('only for the tool that opens an app', () => {
    expect(plainAppOpen('run_command', { executable: 'steam' })).toBe(false);
    expect(plainAppOpen('desktop_click', { executable: 'steam' })).toBe(false);
  });
});

describe('where it needs no approval', () => {
  test('only inside a turn the owner started on the notch', () => {
    expect(ownerAskedOnNotch()).toBe(false);
    expect(appOpenNeedsNoApproval('desktop_launch_app', open('steam'))).toBe(false);
    expect(inTurn('notch-spoken-1', () => appOpenNeedsNoApproval('desktop_launch_app', open('steam')))).toBe(true);
    expect(inTurn('notch-typed-1', () => appOpenNeedsNoApproval('desktop_launch_app', open('steam')))).toBe(true);
    // A dashboard turn, and a turn that only looks like one.
    expect(inTurn('req-123', () => appOpenNeedsNoApproval('desktop_launch_app', open('steam')))).toBe(false);
    expect(inTurn('x-notch-typed-1', () => appOpenNeedsNoApproval('desktop_launch_app', open('steam')))).toBe(false);
  });

  test('never with the notch switch off', () => {
    delete process.env[NOTCH_SWITCH];
    expect(inTurn('notch-spoken-1', () => appOpenNeedsNoApproval('desktop_launch_app', open('steam')))).toBe(false);
  });

  test('the review that every desktop action gets is lifted for it, and for nothing else', () => {
    // Outside a notch turn: reviewed on screen, as always.
    expect(rawUiGate('desktop_launch_app', open('steam'))?.confirm).toBe('always');
    inTurn('notch-spoken-1', () => {
      expect(rawUiGate('desktop_launch_app', open('steam'))).toBeNull();
      const gate = resolveToolGate(undefined, 'desktop_launch_app', open('steam'));
      expect(gate.confirm).toBeUndefined();
      expect(gate.actionCategory).toBe('control_app');
      // With arguments, a shell, another desktop action: still reviewed.
      expect(rawUiGate('desktop_launch_app', open('steam', '-silent'))?.confirm).toBe('always');
      expect(rawUiGate('desktop_launch_app', open('powershell'))?.confirm).toBe('always');
      expect(rawUiGate('desktop_click', { x: 1, y: 2 })?.confirm).toBe('always');
      expect(rawUiGate('desktop_type', { text: 'hello' })?.confirm).toBe('always');
    });
  });
});

describe('who may approve what has to be reviewed on screen', () => {
  const onScreen = { action_category: 'control_app', context: JSON.stringify({ intent: 'Review desktop_click.', confirm: 'always' }) } as const;
  const payment = { action_category: 'make_payment', context: '' } as const;
  const plain = { action_category: 'execute_command', context: '' } as const;

  test('the dashboard, and the notch, which is on that screen. Nothing else', () => {
    // The shape of an on-screen request is the product's own: build one through the gate to be sure.
    const reviewed = rawUiGate('desktop_click', { x: 1, y: 2 });
    expect(reviewed?.confirm).toBe('always');
    expect(approvalDecidableBy(plain, 'telegram')).toBe(true);
    expect(approvalDecidableBy(plain, NOTCH_DECIDER)).toBe(true);
    expect(approvalDecidableBy(payment, DASHBOARD_DECIDER)).toBe(true);
    expect(approvalDecidableBy(payment, NOTCH_DECIDER)).toBe(false);
    expect(approvalDecidableBy(payment, 'telegram')).toBe(false);
    expect(approvalDecidableBy(onScreen, DASHBOARD_DECIDER)).toBe(true);
    expect(approvalDecidableBy(onScreen, NOTCH_DECIDER)).toBe(true);
    for (const other of ['telegram', 'discord', 'toast', 'voice', '', null, undefined]) {
      expect(approvalDecidableBy(onScreen, other)).toBe(false);
    }
  });
});

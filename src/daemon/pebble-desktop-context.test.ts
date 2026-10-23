/**
 * #905: the pebble voice loop reads the desktop on its own, without a tool
 * call -- the foreground window every cycle, a screenshot for a spatial ask --
 * and tells the model to drive desktop apps. With desktop.enabled off none of
 * that may happen: no RPC goes out, and the model is told desktop control is
 * off instead of being told to use tools it does not have. With it on, the
 * reads and the directives are exactly what they were.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { setDesktopEnabledSource } from '../actions/tools/desktop-guard.ts';
import { fetchPebbleForegroundApp, fetchPebbleScreenshot, pebbleActionDirectives, type PebbleDesktopDispatch } from './pebble-desktop-context.ts';

let desktopOn = true;
let sent: string[] = [];
const dispatch: PebbleDesktopDispatch = async (_id, method) => {
  sent.push(method);
  if (method === 'list_windows') return [{ is_foreground: true, title: 'Notes', process_name: 'notes' }];
  if (method === 'capture_screen') return { _binary: { data: 'aGk=', mime_type: 'image/jpeg' }, width: 10, height: 10 };
  throw new Error(`unexpected ${method}`);
};

beforeEach(() => {
  desktopOn = true;
  sent = [];
  setDesktopEnabledSource(() => desktopOn);
});
afterEach(() => setDesktopEnabledSource(null));

describe('pebble desktop reads', () => {
  test('on: the foreground window and the screenshot are read as before', async () => {
    expect(await fetchPebbleForegroundApp(dispatch, 'pc-1')).toEqual({ title: 'Notes', processName: 'notes' });
    expect((await fetchPebbleScreenshot(dispatch, 'pc-1'))?.base64).toBe('aGk=');
    expect(sent).toEqual(['list_windows', 'capture_screen']);
  });

  test('off: neither read dispatches anything, and both report nothing', async () => {
    desktopOn = false;
    expect(await fetchPebbleForegroundApp(dispatch, 'pc-1')).toBeNull();
    expect(await fetchPebbleScreenshot(dispatch, 'pc-1')).toBeNull();
    expect(sent).toEqual([]);
  });
});

describe('pebble action directives', () => {
  test('on: they direct the model to the desktop tools', () => {
    const text = pebbleActionDirectives().join('\n');
    expect(text).toContain('desktop_snapshot');
    expect(text).toContain('desktop_launch_app');
  });

  test('off: no desktop tool is named, and the model is told desktop control is off', () => {
    desktopOn = false;
    const text = pebbleActionDirectives().join('\n');
    expect(text).not.toMatch(/desktop_[a-z_]+/);
    expect(text).toContain('Desktop control is turned off');
    expect(text).toContain('browser_navigate');
    // Nothing desktop is pre-authorized while it is off.
    expect(text).not.toMatch(/opening apps|focusing windows|taking screenshots|Chrome is up/);
    expect(text).toContain('restarting Jarvis');
  });
});

/**
 * #905 review: with awareness off (its service never started) and
 * desktop.enabled false, a sidecar's screen_capture / context_changed /
 * idle_detected events -- OCR text, window titles, app names -- fell through to
 * the generic observer pipeline and were classified, coalesced and broadcast to
 * the dashboard socket. They are dropped now; everything else is unchanged.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { setDesktopEnabledSource, setScreenCaptureEnabledSource } from '../actions/tools/desktop-guard.ts';
import { AWARENESS_EVENT_TYPES, skipGenericSidecarEvent } from './sidecar-event-routing.ts';

let desktopOn = true;
let awarenessOn = true;
beforeEach(() => {
  desktopOn = true; awarenessOn = true;
  setDesktopEnabledSource(() => desktopOn); setScreenCaptureEnabledSource(() => awarenessOn);
});
afterEach(() => { setDesktopEnabledSource(null); setScreenCaptureEnabledSource(null); });

test('desktop off, awareness not running: screen events never reach the generic pipeline', () => {
  desktopOn = false;
  for (const type of AWARENESS_EVENT_TYPES) expect({ type, skipped: skipGenericSidecarEvent(type, false) }).toEqual({ type, skipped: true });
});

test('awareness running: its events are left to it, as before', () => {
  for (const type of AWARENESS_EVENT_TYPES) expect(skipGenericSidecarEvent(type, true)).toBe(true);
});

test('desktop on, awareness switched on but its service not running yet: the old pass-through is unchanged', () => {
  for (const type of AWARENESS_EVENT_TYPES) expect(skipGenericSidecarEvent(type, false)).toBe(false);
});

// #1314 follow-up: after a boot with screen awareness off its service is null,
// and a capture a sidecar sent before the observer pause reached it went
// through the generic pipeline, OCR text and all, to the dashboard socket.
test('desktop on, screen awareness off and its service not running: screen events never reach the generic pipeline', () => {
  awarenessOn = false;
  for (const type of AWARENESS_EVENT_TYPES) expect({ type, skipped: skipGenericSidecarEvent(type, false) }).toEqual({ type, skipped: true });
  for (const type of ['file_change', 'notification', 'clipboard_change']) expect(skipGenericSidecarEvent(type, false)).toBe(false);
});

test('other sidecar events are never skipped here, switch on or off', () => {
  for (const on of [true, false]) {
    desktopOn = on;
    for (const type of ['file_change', 'notification', 'process_started']) {
      expect(skipGenericSidecarEvent(type, false)).toBe(false);
      expect(skipGenericSidecarEvent(type, true)).toBe(false);
    }
  }
});

test('#1159: the clipboard follows the switch: clipboard_change is dropped while desktop is off, kept while on', () => {
  // The sidecar keeps sending what was copied (it cannot be told to pause
  // its observer yet); nothing of it may reach the vault, the dashboard or the
  // observer.clipboard_changed workflow bus while desktop control is off.
  desktopOn = false;
  expect(skipGenericSidecarEvent('clipboard_change', false)).toBe(true);
  expect(skipGenericSidecarEvent('clipboard_change', true)).toBe(true);
  desktopOn = true;
  expect(skipGenericSidecarEvent('clipboard_change', false)).toBe(false);
  expect(skipGenericSidecarEvent('clipboard_change', true)).toBe(false);
});

test('the daemon pipeline asks this predicate', async () => {
  const source = await Bun.file(new URL('./index.ts', import.meta.url)).text();
  expect(source).toMatch(/if \(skipGenericSidecarEvent\(event\.event_type, !!awarenessService\)\) return;/);
});

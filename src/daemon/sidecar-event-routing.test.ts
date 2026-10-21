/**
 * #905 review: with awareness off (its service never started) and
 * desktop.enabled false, a sidecar's screen_capture / context_changed /
 * idle_detected events -- OCR text, window titles, app names -- fell through to
 * the generic observer pipeline and were classified, coalesced and broadcast to
 * the dashboard socket. They are dropped now; everything else is unchanged.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { setDesktopEnabledSource } from '../actions/tools/desktop-guard.ts';
import { AWARENESS_EVENT_TYPES, skipGenericSidecarEvent } from './sidecar-event-routing.ts';

let desktopOn = true;
beforeEach(() => { desktopOn = true; setDesktopEnabledSource(() => desktopOn); });
afterEach(() => setDesktopEnabledSource(null));

test('desktop off, awareness not running: screen events never reach the generic pipeline', () => {
  desktopOn = false;
  for (const type of AWARENESS_EVENT_TYPES) expect({ type, skipped: skipGenericSidecarEvent(type, false) }).toEqual({ type, skipped: true });
});

test('awareness running: its events are left to it, as before', () => {
  for (const type of AWARENESS_EVENT_TYPES) expect(skipGenericSidecarEvent(type, true)).toBe(true);
});

test('desktop on, awareness off: the old pass-through is unchanged', () => {
  for (const type of AWARENESS_EVENT_TYPES) expect(skipGenericSidecarEvent(type, false)).toBe(false);
});

test('other sidecar events are never skipped here, switch on or off', () => {
  for (const on of [true, false]) {
    desktopOn = on;
    for (const type of ['clipboard_change', 'file_change', 'notification', 'process_started']) {
      expect(skipGenericSidecarEvent(type, false)).toBe(false);
      expect(skipGenericSidecarEvent(type, true)).toBe(false);
    }
  }
});

test('the daemon pipeline asks this predicate', async () => {
  const source = await Bun.file(new URL('./index.ts', import.meta.url)).text();
  expect(source).toMatch(/if \(skipGenericSidecarEvent\(event\.event_type, !!awarenessService\)\) return;/);
});

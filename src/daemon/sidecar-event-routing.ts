/**
 * Which sidecar events the generic observer pipeline in daemon/index.ts must
 * leave alone (classify, coalesce, vault, dashboard broadcast).
 *
 * The awareness events carry what is on the screen (ocr_text, window_title,
 * app_name). They belong to the awareness service when it is running. While
 * desktop.enabled is false (#905) they are dropped whether or not awareness
 * runs: with awareness off the service never started, and these events used to
 * fall through to the generic pipeline and reach the dashboard socket.
 *
 * The clipboard follows the same switch (#1159, owner decision): while
 * desktop.enabled is false, clipboard_change events (what the user copied) are
 * dropped before the vault, the classifier, the dashboard and the
 * observer.clipboard_changed workflow bus. A sidecar keeps sending them until
 * it can be told to pause its observer.
 */

import { isDesktopEnabled } from '../actions/tools/desktop-guard.ts';

export const AWARENESS_EVENT_TYPES: readonly string[] = ['screen_capture', 'context_changed', 'idle_detected'];

/** Desktop state the switch covers that is not awareness's: dropped while it is off. */
export const DESKTOP_OBSERVER_EVENT_TYPES: readonly string[] = ['clipboard_change'];

/**
 * Whether this sidecar event carries desktop state the switch has turned off:
 * the clipboard and the screen. Checked on arrival (connection.ts) so that one
 * sent while off and still queued when Settings turns the switch back on is
 * not processed after; every consumer drops these at dispatch while off too.
 */
export function droppedWhileDesktopOff(eventType: string): boolean {
  return (DESKTOP_OBSERVER_EVENT_TYPES.includes(eventType) || AWARENESS_EVENT_TYPES.includes(eventType)) && !isDesktopEnabled();
}

export function skipGenericSidecarEvent(eventType: string, awarenessRunning: boolean): boolean {
  if (DESKTOP_OBSERVER_EVENT_TYPES.includes(eventType)) return !isDesktopEnabled();
  if (!AWARENESS_EVENT_TYPES.includes(eventType)) return false;
  return awarenessRunning || !isDesktopEnabled();
}

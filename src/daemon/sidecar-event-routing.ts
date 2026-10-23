/**
 * Which sidecar events the generic observer pipeline in daemon/index.ts must
 * leave alone (classify, coalesce, vault, dashboard broadcast).
 *
 * The awareness events carry what is on the screen (ocr_text, window_title,
 * app_name). They belong to the awareness service when it is running. While
 * desktop.enabled is false (#905) they are dropped whether or not awareness
 * runs: with awareness off the service never started, and these events used to
 * fall through to the generic pipeline and reach the dashboard socket.
 */

import { isDesktopEnabled } from '../actions/tools/desktop-guard.ts';

export const AWARENESS_EVENT_TYPES: readonly string[] = ['screen_capture', 'context_changed', 'idle_detected'];

export function skipGenericSidecarEvent(eventType: string, awarenessRunning: boolean): boolean {
  if (!AWARENESS_EVENT_TYPES.includes(eventType)) return false;
  return awarenessRunning || !isDesktopEnabled();
}

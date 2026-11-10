import { isScreenCaptureEnabled } from '../actions/tools/desktop-guard.ts';

/** The answer every reader of recorded awareness gives while screen awareness is off (#1314). */
export const AWARENESS_OFF_CODE = 'AWARENESS_OFF';
export const AWARENESS_OFF_MESSAGE = 'Screen awareness is off, so its recorded history is hidden until it is turned back on.';

/**
 * Screen awareness off hides what it recorded (owner decision on #1314):
 * every reader of stored captures, sessions and what is derived from them
 * (suggestions, routines, compositions, opportunities) answers that awareness
 * is off, with no data. Nothing is deleted; it shows again when awareness is
 * turned back on. Null while awareness is on.
 */
export function awarenessHistoryHidden(json: (data: unknown, status?: number) => Response): Response | null {
  return isScreenCaptureEnabled() ? null : json({ error: AWARENESS_OFF_MESSAGE, code: AWARENESS_OFF_CODE }, 409);
}

/** Whether recorded awareness may be read now. */
export function awarenessHistoryVisible(): boolean {
  return isScreenCaptureEnabled();
}

/**
 * A second door for what a desktop app captured.
 *
 * The desktop app decides what it looks at: it does not capture an app on
 * the person's "never watch" list, or anything while a password is being
 * typed or a bank is in front, or while Jarvis is asleep. But a capture can
 * already be on its way when that starts, and events wait in a queue. So the
 * brain asks here before it keeps anything a desktop app saw: the screen, the
 * window in front, how long it has been there.
 *
 * Nothing is set here unless the notch is on (src/notch/where.ts sets it),
 * and with nothing set everything is kept, as before.
 */
export type CaptureGuard = (sidecarId: string, app: string | null) => boolean;

let guard: CaptureGuard | null = null;

export function setCaptureGuard(next: CaptureGuard | null): void {
  guard = next;
}

/** The events that say what is on a screen, and where each names the app. */
const APP_FIELD: Record<string, string> = { screen_capture: 'app_name', context_changed: 'to_app', idle_detected: 'app_name' };

/** Whether an event from a desktop app's observers may be kept. Other events are not this door's. */
export function captureMayBeKept(sidecarId: string, event: { event_type: string; payload?: unknown }): boolean {
  const field = APP_FIELD[event.event_type];
  if (!guard || !field) return true;
  const payload = event.payload && typeof event.payload === 'object' ? event.payload as Record<string, unknown> : {};
  const app = typeof payload[field] === 'string' ? payload[field] as string : null;
  try {
    return guard(sidecarId, app);
  } catch {
    // A guard that cannot answer does not open the door.
    return false;
  }
}

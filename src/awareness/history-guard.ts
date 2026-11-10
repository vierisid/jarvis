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

/** Thrown inside a job when awareness turned off before its next model call (#1314 review). */
export class AwarenessHeldError extends Error {
  constructor() { super('Screen awareness is off; this job waits until it is turned back on.'); this.name = 'AwarenessHeldError'; }
}

/**
 * A model client that refuses every call while screen awareness is off, so a
 * job already running sends nothing more once the switch goes off: the loop
 * head stops the next job, this stops the rest of this one.
 */
export function awarenessHeldLlm<T extends object>(llm: T): T {
  return new Proxy(llm, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (!awarenessHistoryVisible()) throw new AwarenessHeldError();
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

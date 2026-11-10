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
export function awarenessHeldLlm<T extends object>(llm: T, state?: { held: boolean }): T {
  const hold = () => { if (state) state.held = true; return new AwarenessHeldError(); };
  return new Proxy(llm, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (!awarenessHistoryVisible()) throw hold();
        // Inside one call the provider layer retries and falls back to other
        // providers, asking the deadline hook before each attempt (#1314
        // review): the hook asks the switch too, so no retry or fallback
        // sends the prompt once awareness is off.
        const held = (deadline: unknown) => () => {
          if (!awarenessHistoryVisible()) throw hold();
          if (typeof deadline === 'function') (deadline as () => void)();
        };
        if (key === 'chat' && args[0] && typeof args[0] === 'object') {
          const input = args[0] as { checkDeadline?: unknown };
          args = [{ ...input, checkDeadline: held(input.checkDeadline) }, ...args.slice(1)];
        } else if (key === 'chatTools') {
          const next = [...args]; next[3] = held(args[3]); args = next;
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

/**
 * A composition whose every model call is held by the switch (#1314 review):
 * the routine composer is built through this, so its wiring is tested.
 */
export function heldComposition<D extends { llm: object }, R, O>(depsOf: () => D,
  compose: (deps: D, request: R) => Promise<O>): (request: R, state?: { held: boolean }) => Promise<O> {
  // `state` says the switch held a call, which the composer may have turned into an ordinary failure.
  return (request, state) => { const deps = depsOf(); return compose({ ...deps, llm: awarenessHeldLlm(deps.llm, state) }, request); };
}

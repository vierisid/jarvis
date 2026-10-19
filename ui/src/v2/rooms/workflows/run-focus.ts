import { useEffect } from "react";

/**
 * Q-19: the run another surface asked to open (Today's "Open" on a failed
 * run). Held until the Workflows room takes it, so it survives the room
 * mounting after the request; taken once.
 */
export interface RunFocus { flowId: string; runId: string }

let pending: RunFocus | null = null;
const EVENT = "jarvis:focus-run";

export function focusRun(flowId: string, runId: string): void {
  pending = { flowId, runId };
  window.dispatchEvent(new CustomEvent(EVENT));
}

/** Calls `onFocus` with a pending request on mount, and with each later one while mounted. */
export function useRunFocus(onFocus: (target: RunFocus) => void): void {
  useEffect(() => {
    const take = () => {
      const target = pending;
      pending = null;
      if (target) onFocus(target);
    };
    take();
    window.addEventListener(EVENT, take);
    return () => window.removeEventListener(EVENT, take);
  }, [onFocus]);
}

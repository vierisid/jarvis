/**
 * Effects this process has dispatched and not yet recorded, by flow (#1154).
 *
 * Stopping a run marks it STOPPED at once, but an effect it had already
 * claimed (effect-boundary.ts: past claimWorkflowEffect) is still running in
 * this process, and writes its record, its approval receipt and its audit row
 * only when it returns. A delete of the flow in between cascaded the run away
 * first, so that write failed on the missing run and the receipt that should
 * outlive the flow was never written. Deletes now wait for this count to
 * reach zero (db/repos/flow-deletion.ts).
 *
 * In memory on purpose: a dispatch is in flight only in the process running
 * it, and one a crash interrupted is already recorded as `dispatching`, which
 * nothing here can finish.
 *
 * An effect handed to the engine to complete (`externalDispatch`) counts
 * only until the hand-off: its later completion receipt arrives from the
 * engine, whose run the delete has already stopped.
 */

const inFlight = new Map<string, number>();
const waiters = new Map<string, Set<() => void>>();

/** Count a dispatch for `flowId` as started; call the result once it is recorded. */
export function beginEffectDispatch(flowId: string): () => void {
  inFlight.set(flowId, (inFlight.get(flowId) ?? 0) + 1);
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    const left = (inFlight.get(flowId) ?? 1) - 1;
    if (left > 0) {
      inFlight.set(flowId, left);
      return;
    }
    inFlight.delete(flowId);
    const wake = waiters.get(flowId);
    waiters.delete(flowId);
    for (const w of wake ?? []) w();
  };
}

/** True while an effect of a run of `flowId` is being dispatched in this process. */
export function effectDispatchInFlight(flowId: string): boolean {
  return inFlight.has(flowId);
}

/**
 * Resolve true once no effect of `flowId` is in flight, or false if one still
 * is after `timeoutMs`.
 */
export function waitForEffectDispatches(flowId: string, timeoutMs: number): Promise<boolean> {
  if (!inFlight.has(flowId)) return Promise.resolve(true);
  if (timeoutMs <= 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    let set = waiters.get(flowId);
    if (!set) waiters.set(flowId, (set = new Set()));
    const done = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      set!.delete(done);
      resolve(!inFlight.has(flowId));
    }, timeoutMs);
    set.add(done);
  });
}

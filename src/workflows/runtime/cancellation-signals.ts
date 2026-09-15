// The durable fence lives in SQLite. This bus only wakes executors in the
// single daemon process; a restart cannot remove the persisted stop decision.
const listeners = new Map<string, Set<() => void>>();

export function onRunCanceled(runId: string, listener: () => void): () => void {
  let set = listeners.get(runId);
  if (!set) listeners.set(runId, set = new Set());
  set.add(listener);
  return () => {
    set.delete(listener);
    if (!set.size) listeners.delete(runId);
  };
}

export function signalRunCanceled(runId: string): void {
  for (const listener of listeners.get(runId) ?? []) listener();
}

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

// #1018: a run that ended on its own (not stopped). A task the run started
// is released from it then: it keeps running, and what it starts later is
// its own, not the finished run's.
const endedListeners = new Map<string, Set<() => void>>();

export function onRunEnded(runId: string, listener: () => void): () => void {
  let set = endedListeners.get(runId);
  if (!set) endedListeners.set(runId, set = new Set());
  set.add(listener);
  return () => {
    set.delete(listener);
    if (!set.size) endedListeners.delete(runId);
  };
}

export function signalRunEnded(runId: string): void {
  for (const listener of [...(endedListeners.get(runId) ?? [])]) listener();
}

// #1152: a run still executing when its workflow was turned off. The run
// itself is not interrupted (Q-06), so this is not `signalRunCanceled`, which
// aborts the executor; it reaches only the background tasks the run started,
// which are cancelled (owner, 2026-11-06).
const turnedOffListeners = new Map<string, Set<() => void>>();

export function onRunTurnedOff(runId: string, listener: () => void): () => void {
  let set = turnedOffListeners.get(runId);
  if (!set) turnedOffListeners.set(runId, set = new Set());
  set.add(listener);
  return () => {
    set.delete(listener);
    if (!set.size) turnedOffListeners.delete(runId);
  };
}

export function signalRunTurnedOff(runId: string): void {
  for (const listener of [...(turnedOffListeners.get(runId) ?? [])]) listener();
}

// #1426: the owner took the CODE-step permission back from a workflow. Its
// queued, waiting and executing runs are stopped through the run fence; this
// reaches what the fence cannot: an engine parked warm for the workflow,
// which may still hold processes a CODE step left behind, is retired.
const codeRevokedListeners = new Set<(flowId: string) => void>();

export function onCodeStepsRevoked(listener: (flowId: string) => void): () => void {
  codeRevokedListeners.add(listener);
  return () => { codeRevokedListeners.delete(listener); };
}

export function signalCodeStepsRevoked(flowId: string): void {
  for (const listener of [...codeRevokedListeners]) {
    try { listener(flowId); } catch (error) { console.error(`[code-steps] revoke listener failed for flow ${flowId}:`, error); }
  }
}

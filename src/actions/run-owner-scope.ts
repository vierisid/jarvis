import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * #1018: the workflow run a call is made for. A background agent task started
 * from inside it belongs to that run (owner decision, 2026-10-20): it is
 * cancelled when the run is stopped through `cancelFlowRun` (a cancel, Kill,
 * deleting the workflow, or turning it off while the run is queued or
 * waiting), it does not start once the run is stopped or its workflow was
 * turned off, and it keeps the run's machine binding and template-delivery
 * suppression. Turning a workflow off does not stop a run that is executing
 * (Q-06), and a run that ends on its own does not stop its task: neither
 * reaches a task already started. A run that ends on its own releases its
 * tasks (`released`): they keep running, and what they start from then on is
 * their own, so turning off or deleting the finished workflow later refuses
 * nothing.
 *
 * Kept apart from the dispatch fence (`execution-scope.ts`) on purpose. A
 * task leaves that fence, because the fence of the effect that started it
 * refuses once that effect settles (#988); it does not leave its run. A leaf
 * module, so the agent code can read it without importing the workflow
 * database: the workflow runtime supplies what "stopped" means.
 */
export interface RunOwner {
  runId: string;
  /** Whether a task may no longer start for the run: stopped, gone, or its live run's workflow turned off. */
  stopped(): boolean;
  /** Whether the run already ended on its own (finished, not stopped): a task started now is not the run's. */
  ended(): boolean;
  /** Call `listener` once the run is stopped. Returns the unsubscribe. */
  onStopped(listener: () => void): () => void;
  /** Call `listener` once the run ends on its own. Returns the unsubscribe. */
  onEnded(listener: () => void): () => void;
  /** Set on a task's own scope once its run ended on its own: it no longer belongs to the run. */
  released?: boolean;
}

const scope = new AsyncLocalStorage<RunOwner>();

export function withRunOwner<T>(owner: RunOwner, execute: () => T): T {
  return scope.run(owner, execute);
}

/** The workflow run this call is made for, or undefined outside one. */
export function currentRunOwner(): RunOwner | undefined {
  return scope.getStore();
}

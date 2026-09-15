import { AsyncLocalStorage } from "node:async_hooks";

// A dispatch fence supplied by the caller, independent of Authority policy.
// AsyncLocalStorage keeps concurrent workflows (and ordinary chat) isolated.
const scope = new AsyncLocalStorage<() => void>();

export function withExecutionScope<T>(checkpoint: () => void, execute: () => T): T {
  const parent = scope.getStore();
  return scope.run(() => { parent?.(); checkpoint(); }, execute);
}

/** Call synchronously immediately before dispatch, and again after any await. */
export function checkpointExecution(): void {
  scope.getStore()?.();
}

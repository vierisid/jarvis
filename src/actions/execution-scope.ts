import { AsyncLocalStorage } from "node:async_hooks";

// A dispatch fence supplied by the caller, independent of Authority policy.
// AsyncLocalStorage keeps concurrent workflows (and ordinary chat) isolated.
const scope = new AsyncLocalStorage<{ checkpoint: () => void; signal?: AbortSignal }>();

export function withExecutionScope<T>(checkpoint: () => void, execute: () => T, signal?: AbortSignal): T {
  const parent = scope.getStore();
  const inheritedSignal = parent?.signal;
  const combinedSignal = signal && inheritedSignal && signal !== inheritedSignal
    ? AbortSignal.any([inheritedSignal, signal]) : signal ?? inheritedSignal;
  return scope.run({ checkpoint: () => { parent?.checkpoint(); checkpoint(); }, signal: combinedSignal }, execute);
}

/** Pass the caller's cancellation to dependencies that can stop in-flight work. */
export function executionSignal(): AbortSignal | undefined { return scope.getStore()?.signal; }

/** Call synchronously immediately before dispatch, and again after any await. */
export function checkpointExecution(): void {
  scope.getStore()?.checkpoint();
}

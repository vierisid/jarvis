import { FAILURE_CODES, OUTCOMES, type Completion, type EventMetadata, type Sink } from './types.ts';
export interface Observation<Result> {
  /** Classify owner acknowledgements: a resolved promise alone is not success. */
  result?(value: Result): Completion;
  error?(error: unknown): Completion;
  /** Monotonic clock. Injectable for deterministic tests, never a progress timer. */
  now?: () => number;
}
const unknown = (): Completion => ({ outcome: 'unknown', failureCode: 'unknown' });
function clock(now: () => number): number | null {
  try { const value = now(); return Number.isFinite(value) ? value : null; } catch { return null; }
}
function classify<T>(value: T, getClassifier: () => ((value: T) => Completion) | undefined): Completion {
  try {
    const c = getClassifier()?.(value);
    if (c) {
      const { outcome, failureCode } = c;
      if (OUTCOMES.includes(outcome) && FAILURE_CODES.includes(failureCode)
        && !(outcome === 'succeeded' && failureCode !== 'none') && !(outcome === 'failed' && failureCode === 'none')) return { outcome, failureCode };
    }
  } catch { /* Diagnostic classification cannot change an operation's result. */ }
  return unknown();
}
/** Execute exactly once. No timeout, retry or cancellation is imposed on work;
 * absent/broken diagnostic ports and clocks never replace its result/error. */
export async function observeOperation<Context, Result>(sink: Sink<Context> | null | undefined, context: Context,
  metadata: EventMetadata, work: () => Result | Promise<Result>, observation: Observation<Result> = {}): Promise<Result> {
  let now = () => performance.now();
  try { now = observation.now ?? now; } catch { now = () => NaN; }
  const start = sink ? clock(now) : null;
  const elapsed = () => {
    const end = sink ? clock(now) : null;
    return start !== null && end !== null && end >= start ? end - start : null;
  };
  const emit = (durationMs: number | null, completion: Completion) => {
    if (!sink) return;
    try {
      // Only this local envelope is assembled. The sink projects metadata again.
      const input = { ...metadata, ...completion, durationMs };
      void Promise.resolve(sink.record(context, input)).catch(() => {});
    } catch { /* No raw error/message/stack is ever logged here. */ }
  };
  let result: Result;
  try { result = await work(); }
  catch (error) { emit(elapsed(), classify(error, () => observation.error)); throw error; }
  emit(elapsed(), classify(result, () => observation.result));
  return result;
}

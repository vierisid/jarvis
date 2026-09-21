import { raceWithSignal } from '../../util/abort';

/** Named for the budget it bounds, not for the 5-minute claim lease that
 * src/awareness/suggestion-composer.ts calls COMPOSITION_TIMEOUT_MS: a
 * composition now always settles well inside that lease.
 */
const COMPOSITION_BUDGET_MS = 180_000;

export class CompositionTimeoutError extends Error {
  readonly code = 'composition_timeout';
  constructor(timeoutMs: number) {
    // Say which phases shared the budget and what to do next. A bare
    // "timed out" reads as a transport blip the user cannot act on.
    super(
      `Workflow composition exceeded its ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)}s` : `${timeoutMs}ms`} budget, ` +
      'shared by piece discovery, validation repairs, provider retries and the text fallback. ' +
      'No further composition attempts will start: run compose again, or describe a smaller workflow if it keeps timing out.',
    );
    this.name = 'CompositionTimeoutError';
  }
}

/** One deadline for the entire composition, including provider retries and
 * tool-to-text fallback. Always dispose the timer and cancellation listener.
 */
export async function withCompositionBudget<T>(
  run: (signal: AbortSignal, check: () => void) => Promise<T>,
  callerSignal?: AbortSignal,
  timeoutMs = COMPOSITION_BUDGET_MS,
): Promise<T> {
  callerSignal?.throwIfAborted();
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new RangeError('Composition totalTimeoutMs must be a finite positive timer duration');
  }
  const controller = new AbortController();
  const signal = callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal;
  const error = new CompositionTimeoutError(timeoutMs);
  const deadline = performance.now() + timeoutMs;
  const check = () => {
    // Timers cannot fire during synchronous work or a chain of microtasks.
    if (!signal.aborted && performance.now() >= deadline) controller.abort(error);
    signal.throwIfAborted();
  };
  const timer = setTimeout(() => controller.abort(error), timeoutMs);
  try {
    const result = await raceWithSignal(signal, () => run(signal, check));
    check();
    return result;
  } finally {
    clearTimeout(timer);
  }
}

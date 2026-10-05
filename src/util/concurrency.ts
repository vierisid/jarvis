/**
 * A concurrency limiter: at most `limit` of the calls passed to the returned
 * function run at once, the rest wait their turn in arrival order.
 *
 * A finishing call hands its slot straight to the next waiter instead of
 * freeing it and letting the waiter re-acquire. The difference matters: freed
 * first, a caller arriving in the same tick could take the slot before the
 * waiter resumes, and the limit would quietly be exceeded by one.
 * An optional signal removes a cancelled waiter immediately. Once running,
 * the callback remains responsible for stopping its own work on cancellation.
 */
export function createLimiter(limit: number): <T>(fn: () => Promise<T>, signal?: AbortSignal) => Promise<T> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`createLimiter: limit must be a positive integer, got ${limit}`);
  }
  let active = 0;
  const waiting: Array<() => void> = [];

  const release = (): void => {
    const next = waiting.shift();
    if (next) next();
    else active--;
  };

  return async <T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    signal?.throwIfAborted();
    if (active < limit) active++;
    else await new Promise<void>((resolve, reject) => {
      const start = () => { signal?.removeEventListener('abort', cancel); resolve(); };
      const cancel = () => {
        const index = waiting.indexOf(start);
        if (index >= 0) waiting.splice(index, 1);
        signal?.removeEventListener('abort', cancel);
        reject(signal?.reason);
      };
      waiting.push(start);
      signal?.addEventListener('abort', cancel, { once: true });
    });
    try {
      // A slot may have been handed over immediately before cancellation.
      // It still belongs to this call and must be released in finally.
      signal?.throwIfAborted();
      return await fn();
    } finally {
      release();
    }
  };
}

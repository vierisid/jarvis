/**
 * A concurrency limiter: at most `limit` of the calls passed to the returned
 * function run at once, the rest wait their turn in arrival order.
 *
 * A finishing call hands its slot straight to the next waiter instead of
 * freeing it and letting the waiter re-acquire. The difference matters: freed
 * first, a caller arriving in the same tick could take the slot before the
 * waiter resumes, and the limit would quietly be exceeded by one.
 */
export function createLimiter(limit: number): <T>(fn: () => Promise<T>) => Promise<T> {
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

  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active < limit) active++;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

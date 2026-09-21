/** Stop waiting even when a dependency ignores cancellation. The dependency
 * must also receive the signal and fence any late result before writing state.
 */
export async function raceWithSignal<T>(signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return run();
  let onAbort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const result = await Promise.race([run(), cancelled]);
    signal.throwIfAborted();
    return result;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

export async function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await raceWithSignal(signal, () => new Promise<void>(resolve => { timer = setTimeout(resolve, ms); }));
  } finally {
    clearTimeout(timer);
  }
}

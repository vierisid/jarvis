import type { Operation, Transport } from './contract.ts';
const PREFIX = '/api/onboarding-next/v1';
const PATHS: Record<Operation, string> = {
  'journey.read': '/journey/read', 'journey.transition': '/journey/transition', 'setup.read': '/setup/read', 'setup.complete': '/setup/complete',
  'google.read': '/google/read', 'google.begin': '/google/begin', 'google.cancel': '/google/cancel', 'google.callback': '/google/callback',
  'interview.command': '/interview/command', 'tour.command': '/tour/command', 'intent.validate': '/intent/validate',
  'build.submit': '/build/submit', 'build.read': '/build/read', 'build.cancel': '/build/cancel', 'result.read': '/result/read',
};
export class Unavailable extends Error {
  constructor() { super('Onboarding is unavailable. Reconnect to restore your progress.'); }
}
/** Deadline also covers body decoding. Aborting a response never claims rollback. */
export function createTransport(fetcher: (url: string, init?: RequestInit) => Promise<Response> = fetch, timeoutMs = 5000): Transport {
  async function request(path: string, input: Record<string, unknown> | undefined, signal: AbortSignal, budgetMs = timeoutMs) {
    if (signal.aborted) throw new Unavailable();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stop: () => void = () => {};
    const cancelled = new Promise<never>((_, reject) => {
      stop = () => { reject(new Unavailable()); controller.abort(); };
      signal.addEventListener('abort', stop, { once: true });
      timer = setTimeout(stop, budgetMs);
      if (signal.aborted) stop();
    });
    try {
      return await Promise.race([cancelled, (async () => {
        const response = await fetcher(PREFIX + path, {
          method: input ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
          signal: controller.signal,
          headers: { Accept: 'application/json', ...(input ? { 'Content-Type': 'application/json' } : {}) },
          body: input ? JSON.stringify({ schemaVersion: 1, input }) : undefined,
        });
        if (!response.ok || response.headers.get('content-type')?.split(';')[0] !== 'application/json' || !response.body) throw new Unavailable();
        const reader = response.body.getReader();
        const cancel = () => { void reader.cancel().catch(() => {}); };
        controller.signal.addEventListener('abort', cancel, { once: true });
        if (controller.signal.aborted) cancel();
        const chunks: Uint8Array[] = []; let size = 0;
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (controller.signal.aborted) throw new Unavailable();
            if (done) break;
            if ((size += value.byteLength) > 1024 * 1024) { void reader.cancel(); throw new Unavailable(); }
            chunks.push(value);
          }
        } finally { controller.signal.removeEventListener('abort', cancel); reader.releaseLock(); }
        const bytes = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        const body = JSON.parse(new TextDecoder().decode(bytes));
        if (!body || body.schemaVersion !== 1) throw new Unavailable();
        if (input && !Object.hasOwn(body, 'result')) throw new Unavailable();
        return input ? body.result : body;
      })()]);
    } catch { controller.abort(); throw new Unavailable(); }
    finally { clearTimeout(timer); signal.removeEventListener('abort', stop); }
  }
  return { status: signal => request('/status', undefined, signal), call: (op, input, signal) => request(PATHS[op], input, signal, op === 'interview.command' ? Math.max(timeoutMs, 40000) : timeoutMs) };
}

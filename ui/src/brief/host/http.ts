/** One authenticated account/vault lifetime. Never follow an API redirect. */
export function createHostTransport(send: typeof fetch = fetch, onUnauthorized: () => void = () => {}) {
  const lifetime = new AbortController();
  const request = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const path = String(input);
    if (!path.startsWith('/api/') || path.startsWith('//') || lifetime.signal.aborted) throw new Error('Host unavailable');
    const response = await send(path, { ...init, credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      signal: AbortSignal.any([lifetime.signal, ...(init.signal ? [init.signal] : []), AbortSignal.timeout(path === '/api/onboarding-next/v1/journey/transition' && init.method === 'POST' ? 120000 : 45000)]) });
    if (response.status === 401) { onUnauthorized(); throw new Error('Authentication required'); }
    return response;
  }) as typeof fetch;
  const json = async (path: string, init?: RequestInit): Promise<any> => {
    const response = await request(path, init);
    if (response.status === 409 && response.headers.get('content-type')?.includes('application/json')) {
      // Screen awareness off hides what it recorded (#1314): said as such, not as a broken read.
      const body = await response.json().catch(() => null) as { code?: unknown; error?: unknown } | null;
      if (body?.code === 'AWARENESS_OFF') throw new AwarenessOffError();
      throw new HostRefusal(response.status, body);
    }
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
      // Keep what the server said (a refused publish lists its issues) for a caller that can word it.
      const body = response.headers.get('content-type')?.includes('application/json') ? await response.json().catch(() => null) : null;
      throw new HostRefusal(response.status, body);
    }
    const value = await response.json(); lifetime.signal.throwIfAborted(); return value;
  };
  return { request, json, stop: () => lifetime.abort(), signal: lifetime.signal };
}
/** A refused read or write: the status and, when the server sent JSON, what it said. */
export class HostRefusal extends Error {
  constructor(readonly status: number, readonly body: unknown) { super(`Request unavailable (${status})`); this.name = 'HostRefusal'; }
}
export type HostTransport = ReturnType<typeof createHostTransport>;
export const post = (value: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });

/** What a read of recorded awareness answers while screen awareness is off (#1314). */
export const AWARENESS_OFF_TEXT = 'Screen awareness is off, so what it recorded is hidden until you turn it back on.';
export class AwarenessOffError extends Error {
  constructor() { super(AWARENESS_OFF_TEXT); this.name = 'AwarenessOffError'; }
}

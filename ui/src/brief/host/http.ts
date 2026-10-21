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
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error(`Request unavailable (${response.status})`);
    const value = await response.json(); lifetime.signal.throwIfAborted(); return value;
  };
  return { request, json, stop: () => lifetime.abort(), signal: lifetime.signal };
}
export type HostTransport = ReturnType<typeof createHostTransport>;
export const post = (value: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });

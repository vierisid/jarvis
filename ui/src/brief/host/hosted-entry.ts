import { useEffect, useState } from 'react';
import { resolveReleaseEntry } from '../entry/release-route';
import { createHostTransport } from './http';
import { readHost, type HostDescriptor } from './owner';

export function resolveHostedEntry(href: string, host: HostDescriptor | null) {
  return resolveReleaseEntry(href, host?.installMode === 'hosted' && host.dashboard === 'brief' ? 'released' : 'off');
}

type HostState = { status: 'loading' | 'unavailable' } | { status: 'ready'; descriptor: HostDescriptor | null };

/** Read only the authenticated host, never URL/storage, to select the hosted
 * default. Keep that document-start choice through navigation and outages. */
export function useHostedEntry(active: boolean) {
  const [state, setState] = useState<HostState>({ status: 'loading' });
  const [attempt, retry] = useState(0);
  useEffect(() => {
    if (!active || state.status === 'ready') return;
    const http = createHostTransport();
    void (async () => {
      try {
        const response = await http.request('/api/brief/host');
        // A genuinely older daemon has no descriptor. Network/auth errors must
        // not silently select another dashboard or start a second owner.
        const descriptor = response.status === 404 || response.status === 501 ? null
          : response.ok && response.headers.get('content-type')?.includes('application/json') ? readHost(await response.json())
          : (() => { throw Error('Dashboard host unavailable'); })();
        if (!http.signal.aborted) setState({ status: 'ready', descriptor });
      } catch { if (!http.signal.aborted) setState({ status: 'unavailable' }); }
    })();
    return () => http.stop();
  }, [active, attempt]);
  return { state, retry: () => { setState({ status: 'loading' }); retry(n => n + 1); } };
}

import { useEffect, useState } from 'react';
import { isBriefCapabilityEnabled } from '../../../../src/brief/capabilities';

export type Suggestions = 'on' | 'self' | 'off';

/** Prepared opportunities are hosted-only unless a self-hosted operator opts in
 * (docs/opportunity-routines.md). Only a confirmed-enabled capability counts as
 * on; anything else, including an unreadable snapshot, is off. */
export function suggestionsFrom(capabilities: unknown, installMode: string): Suggestions {
  if (isBriefCapabilityEnabled(capabilities, 'preparedOpportunities')) return 'on';
  return installMode === 'self' ? 'self' : 'off';
}

/** Reads the Brief capability snapshot once while `active`. Starts, and stays on failure, as 'off'. */
export function useSuggestions(active: boolean, installMode: string): Suggestions {
  const [capabilities, setCapabilities] = useState<unknown>(null);
  useEffect(() => {
    if (!active || typeof fetch !== 'function') return;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 5000);
    void (async () => {
      try {
        const response = await fetch('/api/brief/host', { cache: 'no-store', credentials: 'same-origin', signal: abort.signal });
        if (!response.ok) return;
        const host = await response.json() as { capabilities?: unknown };
        if (!abort.signal.aborted) setCapabilities(host?.capabilities ?? null);
      } catch { /* stays off */ }
    })();
    return () => { clearTimeout(timer); abort.abort(); };
  }, [active]);
  return suggestionsFrom(capabilities, installMode);
}

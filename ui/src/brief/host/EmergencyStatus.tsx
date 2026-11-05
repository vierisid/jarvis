import React, { createContext, useEffect, useState } from 'react';
import type { HostTransport } from './http';
export type EmergencyState = 'normal' | 'paused' | 'killed' | 'unavailable' | 'loading';
export const EmergencyStatusContext = createContext<EmergencyState>('loading');
/** One scoped read for the entire workspace. Reads never resume or reset work. */
export function useEmergencyStatus(http: HostTransport, changed?: unknown): EmergencyState {
  const [state, setState] = useState<EmergencyState>('loading');
  useEffect(() => {
    const controller = new AbortController(); let sequence = 0;
    const read = async () => {
      const current = ++sequence;
      try {
        const status = await http.json('/api/authority/status', { signal: controller.signal });
        if (controller.signal.aborted || current !== sequence) return;
        setState(status?.enabled === false ? 'normal' : status?.enabled === true && ['normal', 'paused', 'killed'].includes(status.emergency_state) ? status.emergency_state : 'unavailable');
      } catch { if (!controller.signal.aborted && current === sequence) setState('unavailable'); }
    };
    void read(); const timer = window.setInterval(() => void read(), 5000);
    const focused = () => { if (!document.hidden) void read(); };
    window.addEventListener('focus', focused); document.addEventListener('visibilitychange', focused);
    return () => { controller.abort(); window.clearInterval(timer); window.removeEventListener('focus', focused); document.removeEventListener('visibilitychange', focused); };
  }, [http, changed]);
  return state;
}
export function EmergencyStatusBanner({ state, open }: { state: EmergencyState; open(): void }) {
  if (state === 'normal' || state === 'loading') return null;
  return <aside className="brief-human-banner brief-emergency-banner" role="status" aria-label="Emergency controls status">
    <strong>{state === 'paused' ? 'Jarvis is paused globally.' : state === 'killed' ? 'Jarvis emergency stop is active.' : 'Emergency status is unavailable.'}</strong>{' '}
    {state === 'paused' ? 'You can save input and approval responses, but waiting workflows cannot continue until you resume Jarvis.'
      : state === 'killed' ? 'Stopped runs will not restart automatically. Review Emergency controls before starting new work.'
      : 'Jarvis could not check whether work is paused or stopped. Check Emergency controls before retrying a run.'}{' '}
    <button onClick={open}>Open Emergency controls</button>
  </aside>;
}

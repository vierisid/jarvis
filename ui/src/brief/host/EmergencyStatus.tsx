import React, { createContext, useEffect, useRef, useState } from 'react';
import type { HostTransport } from './http';
export type EmergencyState = 'normal' | 'paused' | 'killed' | 'unavailable' | 'loading';
export const EmergencyStatusContext = createContext<EmergencyState>('loading');
const STATES: readonly EmergencyState[] = ['normal', 'paused', 'killed'];
/** Consecutive failed reads before a known state stops standing: one blip keeps it. */
const FAILURES_BEFORE_UNAVAILABLE = 2;
/**
 * One scoped read for the entire workspace. Reads never resume or reset work.
 * `changed` is the daemon's emergency broadcast counter: each new value reads
 * the status again at once. The 5 second poll and focus reads stay as backup
 * for a broadcast missed while the socket was down.
 */
export function useEmergencyStatus(http: HostTransport, changed?: unknown): EmergencyState {
  const [state, setState] = useState<EmergencyState>('loading');
  const readRef = useRef<() => void>(() => {});
  useEffect(() => {
    // One read at a time: a request asked for while one is in flight runs once
    // it settles, so a slow status route still commits a result.
    const controller = new AbortController(); let reading = false, again = false, failures = 0, known = false;
    const failed = () => { failures++; if (!known || failures >= FAILURES_BEFORE_UNAVAILABLE) setState('unavailable'); };
    const read = async (): Promise<void> => {
      if (reading) { again = true; return; }
      reading = true; again = false;
      try {
        const status = await http.json('/api/authority/status', { signal: controller.signal });
        if (controller.signal.aborted) return;
        // `enabled: false` means this daemon has no Authority engine or
        // emergency controller wired, so there is no pause or stop to hold any
        // work: nothing is shown, as for normal operation (owner decision).
        const next: EmergencyState | null = status?.enabled === false ? 'normal'
          : status?.enabled === true && STATES.includes(status.emergency_state) ? status.emergency_state : null;
        if (next) { failures = 0; known = true; setState(next); } else failed();
      } catch { if (!controller.signal.aborted) failed(); }
      finally { reading = false; }
      if (again && !controller.signal.aborted) return read();
    };
    readRef.current = () => void read();
    void read(); const timer = window.setInterval(() => void read(), 5000);
    const focused = () => { if (!document.hidden) void read(); };
    window.addEventListener('focus', focused); document.addEventListener('visibilitychange', focused);
    return () => { controller.abort(); readRef.current = () => {}; window.clearInterval(timer); window.removeEventListener('focus', focused); document.removeEventListener('visibilitychange', focused); };
  }, [http]);
  const first = useRef(true);
  useEffect(() => { if (first.current) { first.current = false; return; } readRef.current(); }, [changed]);
  return state;
}
export function EmergencyStatusBanner({ state, open }: { state: EmergencyState; open(): Promise<{ state: string } | void> | void }) {
  const [message, setMessage] = useState('');
  useEffect(() => setMessage(''), [state]);
  if (state === 'normal' || state === 'loading') return null;
  const go = async () => {
    setMessage('');
    try {
      const result = await open();
      // A cancelled handoff (the person chose to stay with a draft) is not a failure.
      if (result && result.state === 'unavailable') setMessage('Emergency controls could not be opened. Try again.');
    } catch { setMessage('Emergency controls could not be opened. Try again.'); }
  };
  return <aside className="brief-root brief-emergency-banner" data-state={state} role="status" aria-label="Emergency controls status">
    <p><strong>{state === 'paused' ? 'Jarvis is paused globally.' : state === 'killed' ? 'Jarvis emergency stop is active.' : 'Emergency status is unavailable.'}</strong>{' '}
    {state === 'paused' ? 'You can save input and approval responses, but waiting workflows cannot continue until you resume Jarvis.'
      : state === 'killed' ? 'Stopped runs will not restart automatically. Review Emergency controls before starting new work.'
      : 'Jarvis could not check whether work is paused or stopped. Check Emergency controls before retrying a run.'}</p>
    <button type="button" onClick={() => void go()}>Open Emergency controls</button>
    {message && <p className="brief-emergency-banner__message">{message}</p>}
  </aside>;
}

import React, { useEffect, useState } from 'react';
/** How long Jarvis must stay unreachable before the page says so: a brief blip stays silent. */
export const CONNECTION_GRACE_MS = 4000;
/**
 * `down` is the live evidence that the dashboard cannot reach Jarvis (socket
 * closed and a read failing). Returns true only once it has held for the whole
 * grace period, and false again the moment either signal recovers.
 */
export function useConnectionLost(down: boolean, graceMs = CONNECTION_GRACE_MS): boolean {
  const [lost, setLost] = useState(false);
  useEffect(() => {
    if (!down) { setLost(false); return; }
    const timer = window.setTimeout(() => setLost(true), graceMs);
    return () => window.clearTimeout(timer);
  }, [down, graceMs]);
  return down && lost;
}
export function ConnectionLostBanner({ retry }: { retry(): void }) {
  return <aside className="brief-root brief-connection-banner" role="status" aria-label="Connection to Jarvis">
    <p><strong>Jarvis is not reachable.</strong> Your work is safe; this page will reconnect on its own.</p>
    <button type="button" onClick={retry}>Retry</button>
  </aside>;
}

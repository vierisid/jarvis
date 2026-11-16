import React, { useEffect, useState } from 'react';
import type { HostTransport } from './http';
export interface StorageProblem { message: string }
/**
 * Whether Jarvis can save. Reads the daemon's health on the same slow beat as
 * the emergency status. A failed read says nothing here: the connection
 * notices already cover an unreachable daemon.
 */
export function useStorageStatus(http: HostTransport): StorageProblem | null {
  const [problem, setProblem] = useState<StorageProblem | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const read = async () => {
      try {
        const health = await http.json('/api/health', { signal: controller.signal });
        if (controller.signal.aborted) return;
        const storage = health?.storage;
        setProblem(storage && storage.writable === false
          ? { message: typeof storage.message === 'string' && storage.message ? storage.message : 'Jarvis cannot save right now.' }
          : null);
      } catch { /* unreachable daemon is reported elsewhere */ }
    };
    void read();
    const timer = window.setInterval(() => void read(), 10000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [http]);
  return problem;
}
export function StorageStatusBanner({ problem }: { problem: StorageProblem | null }) {
  if (!problem) return null;
  return <aside className="brief-root brief-emergency-banner brief-storage-banner" data-state="storage" role="alert" aria-label="Saving is not working">
    <p><strong>{problem.message}</strong>{' '}Changes you make now may be lost, and workflow runs wait until saving works again.</p>
  </aside>;
}

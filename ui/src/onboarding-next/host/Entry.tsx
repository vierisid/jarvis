import React, { useEffect, useState, type ReactNode } from 'react';
import type { Configuration } from './contract.ts';
import { createSession, type Session } from './session.ts';
import { ViewHost } from './ViewHost.tsx';
import { createTransport } from './transport.ts';
import { viewModules } from './generated/catalog.ts';

/** Production has no enablement, release decision or fake feature adapters.
 * The release owner supplies the verified assembly through a trusted prop. */
export const productionConfiguration: Configuration = {
  enabled: false, modules: viewModules, transport: createTransport(), adapters: {},
};
export function OptionalOnboardingEntry({ configuration = productionConfiguration, legacy, children }: {
  configuration?: Configuration; legacy: ReactNode; children: ReactNode;
}) {
  // Freeze the assembly for this mount: toggles cannot half-switch a journey.
  const [selected] = useState(() => ({ configuration, enabled: configuration.enabled }));
  if (!selected.enabled) return <>{legacy}</>;
  return <EnabledEntry configuration={selected.configuration} legacy={legacy}>{children}</EnabledEntry>;
}
function EnabledEntry({ configuration, legacy, children }: { configuration: Configuration; legacy: ReactNode; children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  useEffect(() => {
    const next = createSession(configuration); setSession(next); void next.start();
    return () => next.dispose();
  }, [configuration]);
  return session ? <ViewHost session={session} legacy={legacy}>{children}</ViewHost> : <p role="status">Restoring onboarding…</p>;
}

import { useEffect, useSyncExternalStore } from 'react';
import type { BriefReconciliationClient } from './client';
import type { Projection } from './resource';

export function useBriefReconciliation(client: BriefReconciliationClient | undefined, enabled: boolean) {
  useEffect(() => { if (enabled) client?.start(); return () => client?.stop(); }, [client, enabled]);
  return enabled ? client?.observer : undefined;
}
/** Keep the projection stable (useMemo by canonical query/selection); no room key/remount is needed. */
export function useBriefProjection<T>(projection: Projection<T>) {
  return useSyncExternalStore(projection.subscribe, projection.getSnapshot, projection.getSnapshot);
}

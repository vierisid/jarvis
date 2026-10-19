import type { BriefRegistration } from '../capabilities';

/** Read-only host readiness. Activation remains explicit and off by default. */
export function registerReconciliation(read?: () => { snapshots: boolean; sharedSocket: boolean; identityLifecycle: boolean }): BriefRegistration[] {
  if (!read) return [];
  return [{ id: 'reconciliation', provider: { readiness() {
    const value = read();
    return value.snapshots === true && value.sharedSocket === true && value.identityLifecycle === true ? 'ready' : 'unavailable';
  } } }];
}

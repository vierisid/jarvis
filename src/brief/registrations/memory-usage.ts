import type { BriefRegistration } from '../capabilities';
import type { MemoryUsageLedger } from '../../vault/memory-usage';
export function registerMemoryUsage(provider?: MemoryUsageLedger): BriefRegistration[] {
  return provider ? [{ id: 'memoryUsage', provider }] : [];
}

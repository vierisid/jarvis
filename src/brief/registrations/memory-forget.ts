import type { BriefRegistration } from '../capabilities';
import type { MemoryForget } from '../memory-forget';
export function registerMemoryForget(provider?: MemoryForget): BriefRegistration[] {
  return provider ? [{ id: 'memoryForget', provider }] : [];
}

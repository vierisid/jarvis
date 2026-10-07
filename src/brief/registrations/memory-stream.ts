import type { BriefRegistration } from '../capabilities';
import type { MemoryStream } from '../memory-stream';
export function registerMemoryStream(provider?: MemoryStream): BriefRegistration[] {
  return provider ? [{ id: 'memoryStream', provider }] : [];
}

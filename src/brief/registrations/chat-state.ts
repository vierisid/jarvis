import type { BriefRegistration } from '../capabilities';
import type { BriefProvider } from '../providers';

/** Advertise the shipped F-04 client protocol only while its actual backing services are ready. */
export function registerChatState(conversations: BriefProvider, transport: BriefProvider): BriefRegistration[] {
  return [{ id: 'chatState', provider: { readiness() {
    const dependencies = [conversations.readiness(), transport.readiness()];
    if (dependencies.includes('unavailable')) return 'unavailable';
    return dependencies.includes('loading') ? 'loading' : 'ready';
  } } }];
}

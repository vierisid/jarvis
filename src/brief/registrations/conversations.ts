import type { BriefRegistration } from '../capabilities.ts';
import type { BriefReadProviders } from '../providers.ts';

/** F-02 supplies the implementation. Absence installs nothing and stays unsupported. */
export function registerConversations(provider?: BriefReadProviders['conversations']): BriefRegistration[] {
  return provider ? [{ id: 'conversations', provider }] : [];
}

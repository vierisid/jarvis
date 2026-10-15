import type { BriefRegistration } from '../capabilities.ts';
import type { BriefReadProviders } from '../providers.ts';

/** Register a workspace-bound provider explicitly. Absence stays unsupported. */
export function registerConversations(provider?: BriefReadProviders['conversations']): BriefRegistration[] {
  return provider ? [{ id: 'conversations', provider }] : [];
}

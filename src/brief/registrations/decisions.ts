import type { BriefRegistration } from '../capabilities.ts';
import type { BriefReadProviders } from '../providers.ts';

/** F-12 supplies the implementation, independently of the conversation module. */
export function registerDecisions(provider?: BriefReadProviders['decisions']): BriefRegistration[] {
  return provider ? [{ id: 'decisions', provider }] : [];
}

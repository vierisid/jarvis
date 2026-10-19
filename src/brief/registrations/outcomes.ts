import type { BriefRegistration } from '../capabilities';
import type { Outcomes } from '../outcomes';
export function registerOutcomes(provider?: Outcomes): BriefRegistration[] {
  return provider ? [{ id: 'outcomes', provider }] : [];
}

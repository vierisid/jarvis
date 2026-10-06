import type { OpportunityActivation } from '../opportunity-activation';
import type { BriefRegistration } from '../capabilities';
export function registerOpportunityActivation(provider: OpportunityActivation): BriefRegistration[] {
  return [{ id: 'opportunityActivation', provider }];
}

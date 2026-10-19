import type { PreparedOpportunities } from '../../awareness/prepared-opportunities';
import type { BriefRegistration } from '../capabilities';
export function registerPreparedOpportunities(provider: PreparedOpportunities): BriefRegistration[] {
  return [{ id: 'preparedOpportunities', provider }];
}

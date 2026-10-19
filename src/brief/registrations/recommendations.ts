import type { BriefRegistration } from '../capabilities';
import type { Recommendations } from '../recommendations';
export function registerRecommendations(provider?: Recommendations): BriefRegistration[] {
  return provider ? [{ id: 'recommendations', provider }] : [];
}

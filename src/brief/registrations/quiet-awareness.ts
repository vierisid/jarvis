import type { AwarenessDeliveryPolicy } from '../../daemon/awareness-delivery-policy';
import type { BriefRegistration } from '../capabilities';

export function registerQuietAwareness(provider: AwarenessDeliveryPolicy): BriefRegistration[] {
  return [{ id: 'quietAwareness', provider }];
}

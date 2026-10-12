import type { BriefRegistration } from '../capabilities';
import type { ProfileSettings } from '../profile-settings';
export function registerProfileSettings(provider?: ProfileSettings): BriefRegistration[] {
  return provider ? [{ id: 'profileSettings', provider }] : [];
}

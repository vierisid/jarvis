import type { BriefProvider } from '../providers';
import type { BriefRegistration } from '../capabilities';

export interface NavigationReadiness {
  /** Host integration checks, not inferred from the shell flag or HTTP reachability. */
  destinations: boolean;
  guardedNavigation: boolean;
  roomIntents: boolean;
  notificationsOutsideChat: boolean;
}
/** Composition owner registers only after all retained destinations and adapters are wired.
 * Keep activation separate: registration alone never enables navigationCompatibility.
 */
export function registerNavigationCompatibility(read?: () => NavigationReadiness): BriefRegistration[] {
  if (!read) return [];
  const provider: BriefProvider = {
    readiness() {
      const value = read();
      return value.destinations === true && value.guardedNavigation === true && value.roomIntents === true
        && value.notificationsOutsideChat === true ? 'ready' : 'unavailable';
    },
  };
  return [{ id: 'navigationCompatibility', provider }];
}

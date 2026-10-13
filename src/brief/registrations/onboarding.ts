import type { BriefRegistration } from '../capabilities';

/** Host composition owns wiring the tour targets, canonical progress and draft route.
 * Registration never enables onboarding; F-01 also requires enabled F-07 composition. */
export function registerOnboarding(read?: () => {
  targets: boolean; progress: boolean; draftHandoff: boolean;
}): BriefRegistration[] {
  if (!read) return [];
  return [{ id: 'onboarding', provider: { readiness() {
    const value = read();
    return value.targets === true && value.progress === true && value.draftHandoff === true ? 'ready' : 'unavailable';
  } } }];
}

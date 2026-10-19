/** Stable v1 IDs matching the approved U05/U06 order; no sibling import. */
export const TOUR_STEPS = ['today', 'workflows', 'opportunities', 'needs-you', 'goals', 'memory',
  'connected-workspace', 'authority', 'profile', 'settings', 'billing', 'pebble'] as const;
export type TourStep = typeof TOUR_STEPS[number];
export const isTourStep = (value: unknown): value is TourStep => typeof value === 'string' && (TOUR_STEPS as readonly string[]).includes(value);
const LEGACY: Readonly<Record<string, TourStep>> = {
  workflows: 'workflows', talk: 'pebble', context: 'memory', apps: 'connected-workspace', authority: 'authority',
};
/** Interpret only known hints. Unknown legacy positions restart the new tour,
 * never complete it. Completion is owned by the journey and checked first. */
export function legacyTourStep(hint: string | null): TourStep {
  if (!hint) return 'today';
  const value = hint.startsWith('brief:v1:') ? hint.slice(9) : hint;
  return isTourStep(value) ? value : Object.hasOwn(LEGACY, value) ? LEGACY[value]! : 'today';
}
export const accountMenuRoom = (step: TourStep) => ['profile', 'settings', 'billing'].includes(step);

import type { BriefRegistration } from '../capabilities';
import type { GoalMeasurements } from '../goal-measurements';
export function registerGoalMeasurements(provider?: GoalMeasurements): BriefRegistration[] {
  return provider ? [{ id: 'goalMeasurements', provider }] : [];
}

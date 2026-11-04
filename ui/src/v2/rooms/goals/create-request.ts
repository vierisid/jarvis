export const GOAL_CREATE_EVENT = 'jarvis:goal-create';
let pending = false;
export function requestGoalCreation() {
  pending = true;
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(GOAL_CREATE_EVENT));
}
export function takeGoalCreation() {
  const requested = pending; pending = false; return requested;
}
/** Drop an unconsumed request, so a later visit to Goals does not act on it. */
export function clearGoalCreation() { pending = false; }

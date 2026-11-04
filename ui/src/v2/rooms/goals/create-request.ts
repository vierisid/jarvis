export const GOAL_CREATE_EVENT = 'jarvis:goal-create';
let pending = false;
export function requestGoalCreation() {
  pending = true;
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(GOAL_CREATE_EVENT));
}
export function takeGoalCreation() {
  const requested = pending; pending = false; return requested;
}

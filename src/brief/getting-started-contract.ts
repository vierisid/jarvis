/** Personal setup acknowledgements, never permissions or completed work. */
export const GETTING_STARTED_IDS = ['goal', 'authority', 'governed-actions', 'connections', 'profile', 'memory', 'workflow', 'approvals', 'opportunities', 'preferences'] as const;
export type GettingStartedId = typeof GETTING_STARTED_IDS[number];
export interface GettingStartedState { revision: number; completed: GettingStartedId[]; hidden: boolean }
export type GettingStartedChange = { item: GettingStartedId; done: boolean } | { hidden: boolean };
export function isGettingStartedState(value: unknown): value is GettingStartedState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const s = value as GettingStartedState;
  return Object.keys(s).length === 3 && Number.isSafeInteger(s.revision) && s.revision >= 0 && typeof s.hidden === 'boolean'
    && Array.isArray(s.completed) && s.completed.length <= 10 && new Set(s.completed).size === s.completed.length
    && s.completed.every(id => GETTING_STARTED_IDS.includes(id));
}

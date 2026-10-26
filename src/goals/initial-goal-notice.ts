/** Onboarding finished without the interview goal because the planner failed.
 * The dashboard says so until the owner creates any goal; creating one clears it. */
import { deleteSetting, getSetting, setSetting } from '../vault/settings';

const KEY = 'goals.initial-goal-unplanned.v1';

export function markInitialGoalUnplanned(at = Date.now()): void { setSetting(KEY, JSON.stringify({ at })); }
export function initialGoalUnplanned(): boolean { return getSetting(KEY) !== null; }
export function clearInitialGoalUnplanned(): void { deleteSetting(KEY); }

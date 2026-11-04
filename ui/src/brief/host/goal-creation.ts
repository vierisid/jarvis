import type { NavigationCompatibility, NavigationResult } from '../navigation/controller';
import { clearGoalCreation, requestGoalCreation } from '../../v2/rooms/goals/create-request';

const GOALS_HASH = '#/_room_goals';

/**
 * Brief's Add goal: open Goals, then ask it to open its create dialog. The
 * request is made only once the navigation committed: made earlier, a failed
 * commit left it pending, and the next unrelated visit to Goals opened the
 * dialog by itself (#1245). A committed request that Goals never consumed (its
 * room failed to load, or the person moved on first) is dropped when the hash
 * leaves Goals, for the same reason.
 */
export async function openGoalCreation(navigation: Pick<NavigationCompatibility, 'open'>, explain: (message: string) => void): Promise<NavigationResult> {
  const result = await navigation.open(() => {
    explain('');
    return { target: { kind: 'legacy', hash: GOALS_HASH }, message: null };
  });
  if (result.state === 'opened') {
    requestGoalCreation();
    const left = () => {
      if (window.location.hash.startsWith(GOALS_HASH)) return;
      window.removeEventListener('hashchange', left);
      clearGoalCreation();
    };
    window.addEventListener('hashchange', left);
  }
  return result;
}

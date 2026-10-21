/** First dashboard handoff: a saved objective, never automatic execution. */
import { getDb } from '../../vault/schema';
import { createGoal, findGoals } from '../../vault/goals';
import { getSetting, setSetting } from '../../vault/settings';
import { getUserProfile } from '../../vault/user-profile';
import { interviewSourceWithheld } from '../../vault/memory-suppression';
import type { JourneySnapshot } from '../journey/types';

export function saveInitialInterviewGoal(snapshot: JourneySnapshot): void {
  if (snapshot.stepId !== 'exited' || !['completed', 'explored'].includes(snapshot.completion)
    || snapshot.interviewState !== 'done') return;
  const key = `onboarding-next.initial-goal.v1.${snapshot.scopeId}.${snapshot.journeyId}`;
  getDb().transaction(() => {
    // The receipt survives deletion and replay, so a removed goal stays removed.
    if (getSetting(key) !== null) return;
    const existing = findGoals({ limit: 1 })[0];
    const fact = getUserProfile()?.interview_facts?.filter(f => f.theme.toLowerCase() === 'goals'
      && f.summary.trim() && !interviewSourceWithheld(getDb(), f))
      .sort((a, b) => a.recorded_at - b.recorded_at).at(-1);
    const goal = existing ?? (fact ? createGoal(fact.summary, 'objective', {
      description: fact.raw_quote || fact.summary, status: 'draft', authority_level: 0,
      tags: ['onboarding'],
    }) : null);
    setSetting(key, JSON.stringify({ goalId: goal?.id ?? null }));
  })();
}

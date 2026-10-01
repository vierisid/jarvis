import type { Goal, GoalHealth } from './types.ts';

export function calculateGoalHealth(goal: Goal): GoalHealth {
  // If no deadline, base purely on score
  if (goal.deadline === null) {
    if (goal.score >= 0.6) return 'on_track';
    if (goal.score >= 0.3) return 'at_risk';
    return 'behind';
  }

  const now = Date.now();
  const startTime = goal.started_at ?? goal.created_at;
  const totalDuration = goal.deadline - startTime;
  const elapsed = now - startTime;

  // If past deadline
  if (now > goal.deadline) {
    if (goal.score >= 0.7) return 'on_track'; // nearly done
    if (goal.score >= 0.4) return 'behind';
    return 'critical';
  }

  // Ratio: how far along are we in time vs score
  const timeRatio = totalDuration > 0 ? elapsed / totalDuration : 0;
  const expectedScore = timeRatio * 0.7; // expecting 0.7 = good at deadline

  const gap = expectedScore - goal.score;

  if (gap <= 0) return 'on_track';      // ahead of pace
  if (gap <= 0.15) return 'at_risk';     // slightly behind
  if (gap <= 0.3) return 'behind';       // significantly behind
  return 'critical';                      // way behind
}

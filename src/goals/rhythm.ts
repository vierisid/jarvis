/**
 * Daily Rhythm — Morning Plan + Evening Review
 *
 * Morning: queries active goals + calendar → LLM generates focus areas,
 * daily actions, warnings (drill sergeant tone) → creates check-in.
 * Evening: gets morning plan + day's progress → LLM scores day,
 * generates accountability assessment → updates scores.
 */

import type { Goal, GoalCheckIn } from './types.ts';
import type { GoalEvent } from './events.ts';
import * as vault from '../vault/goals.ts';

export type MorningPlanResult = {
  checkIn: GoalCheckIn;
  focusAreas: string[];
  dailyActions: string[];
  warnings: string[];
  message: string; // Drill sergeant message to the user
};

export type EveningReviewResult = {
  checkIn: GoalCheckIn;
  scoreUpdates: { goalId: string; newScore: number; reason: string }[];
  assessment: string; // Day summary
  message: string; // Drill sergeant verdict
};

export class DailyRhythm {
  private llmManager: any; // LLMManager
  private eventCallback: ((event: GoalEvent) => void) | null = null;
  private accountabilityStyle: 'drill_sergeant' | 'supportive' | 'balanced';

  constructor(llmManager: unknown, style: 'drill_sergeant' | 'supportive' | 'balanced' = 'drill_sergeant') {
    this.llmManager = llmManager;
    this.accountabilityStyle = style;
  }

  setEventCallback(cb: (event: GoalEvent) => void): void {
    this.eventCallback = cb;
  }

  private emit(event: GoalEvent): void {
    if (this.eventCallback) this.eventCallback(event);
  }

  /**
   * Run morning planning session.
   */
  async runMorningPlan(): Promise<MorningPlanResult> {
    const activeGoals = vault.findGoals({ status: 'active', limit: 20 });
    const overdueGoals = vault.getOverdueGoals();
    const yesterdayEvening = vault.getRecentCheckIns('evening_review', 1);

    const goalSummary = activeGoals.map(g =>
      `- ${g.title} (${g.level}, score: ${g.score}, health: ${g.health}, deadline: ${g.deadline ? new Date(g.deadline).toLocaleDateString() : 'none'})`
    ).join('\n');

    const overdueSummary = overdueGoals.length > 0
      ? `\n\nOVERDUE GOALS:\n${overdueGoals.map(g => `- ${g.title} (due ${new Date(g.deadline!).toLocaleDateString()})`).join('\n')}`
      : '';

    const yesterdaySummary = yesterdayEvening.length > 0
      ? `\n\nYesterday's review:\n${yesterdayEvening[0]!.summary}`
      : '';

    const prompt = [
      { role: 'system' as const, content: this.buildMorningPrompt() },
      {
        role: 'user' as const,
        content: `Active goals:\n${goalSummary}${overdueSummary}${yesterdaySummary}\n\nGenerate today's morning plan. Respond with ONLY valid JSON.`,
      },
    ];

    try {
      const response = await this.llmManager.chatTier('medium', 'goal_morning_plan', prompt, {
        temperature: 0.4,
        max_tokens: 2000,
      });

      const text = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
      const json = text.match(/\{[\s\S]*\}/)?.[0];
      const plan = json ? JSON.parse(json) : this.fallbackMorningPlan(activeGoals);

      const focusAreas: string[] = plan.focus_areas ?? [];
      const dailyActions: string[] = plan.daily_actions ?? [];
      const warnings: string[] = plan.warnings ?? [];
      const message: string = plan.message ?? 'Time to work.';

      const goalsReviewed = activeGoals.map(g => g.id);

      const checkIn = vault.createCheckIn(
        'morning_plan',
        `Focus: ${focusAreas.join(', ')}`,
        goalsReviewed,
        dailyActions,
      );

      this.emit({
        type: 'check_in_morning',
        data: { checkInId: checkIn.id, focusAreas, dailyActions, warnings },
        timestamp: Date.now(),
      });

      return { checkIn, focusAreas, dailyActions, warnings, message };
    } catch (err) {
      console.error('[DailyRhythm] Morning plan LLM error:', err);
      const fallback = this.fallbackMorningPlan(activeGoals);
      const checkIn = vault.createCheckIn(
        'morning_plan',
        'Morning plan (fallback)',
        activeGoals.map(g => g.id),
        fallback.daily_actions,
      );
      return {
        checkIn,
        focusAreas: fallback.focus_areas,
        dailyActions: fallback.daily_actions,
        warnings: fallback.warnings,
        message: fallback.message,
      };
    }
  }

  /**
   * Run evening review session.
   */
  async runEveningReview(): Promise<EveningReviewResult> {
    const activeGoals = vault.findGoals({ status: 'active', limit: 20 });
    const morningCheckIn = vault.getTodayCheckIn('morning_plan');

    const goalSummary = activeGoals.map(g =>
      `- ${g.title} (${g.level}, score: ${g.score}, health: ${g.health})`
    ).join('\n');

    const plannedActions = morningCheckIn?.actions_planned ?? [];
    const morningContext = morningCheckIn
      ? `\nMorning plan:\n- Focus: ${morningCheckIn.summary}\n- Planned actions:\n${plannedActions.map(a => `  * ${a}`).join('\n')}`
      : '\nNo morning plan was created today.';

    const prompt = [
      { role: 'system' as const, content: this.buildEveningPrompt() },
      {
        role: 'user' as const,
        content: `Active goals:\n${goalSummary}${morningContext}\n\nReview the day and score progress. Respond with ONLY valid JSON.`,
      },
    ];

    try {
      const response = await this.llmManager.chatTier('medium', 'goal_evening_review', prompt, {
        temperature: 0.4,
        max_tokens: 2000,
      });

      const text = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
      const json = text.match(/\{[\s\S]*\}/)?.[0];
      const review = json ? JSON.parse(json) : this.fallbackEveningReview();

      const scoreUpdates: { goalId: string; newScore: number; reason: string }[] = review.score_updates ?? [];
      const assessment: string = review.assessment ?? 'Day complete.';
      const message: string = review.message ?? 'Another day done.';
      const actionsCompleted: string[] = review.actions_completed ?? [];

      // Apply score updates
      for (const update of scoreUpdates) {
        vault.updateGoalScore(update.goalId, update.newScore, update.reason, 'daily_review');
      }

      const goalsReviewed = activeGoals.map(g => g.id);
      const checkIn = vault.createCheckIn(
        'evening_review',
        assessment,
        goalsReviewed,
        [],
        actionsCompleted,
      );

      this.emit({
        type: 'check_in_evening',
        data: { checkInId: checkIn.id, scoreUpdates, assessment },
        timestamp: Date.now(),
      });

      return { checkIn, scoreUpdates, assessment, message };
    } catch (err) {
      console.error('[DailyRhythm] Evening review LLM error:', err);
      const checkIn = vault.createCheckIn(
        'evening_review',
        'Evening review (fallback)',
        activeGoals.map(g => g.id),
        [],
        [],
      );
      return {
        checkIn,
        scoreUpdates: [],
        assessment: 'Review completed without LLM.',
        message: 'Day over. Check your goals manually.',
      };
    }
  }

  // ── Prompts ──────────────────────────────────────────────────────

  private buildMorningPrompt(): string {
    const tone = this.getToneInstructions();
    return `You are JARVIS, an AI assistant running a morning planning session.${tone}

Analyze the user's active goals and generate today's plan.

Respond with ONLY valid JSON:
{
  "focus_areas": ["top 1-3 priorities for today"],
  "daily_actions": ["specific actionable tasks for today"],
  "warnings": ["any urgent warnings about deadlines, health, or missed targets"],
  "message": "motivational/accountability message to the user"
}`;
  }

  private buildEveningPrompt(): string {
    const tone = this.getToneInstructions();
    return `You are JARVIS, an AI assistant running an evening review session.${tone}

Compare the morning plan against the day's reality. Score progress honestly.

Respond with ONLY valid JSON:
{
  "score_updates": [{ "goalId": "id", "newScore": 0.0-1.0, "reason": "why" }],
  "actions_completed": ["what got done today"],
  "assessment": "honest day summary",
  "message": "accountability verdict for the user"
}

Only include score_updates for goals where you have evidence of progress or regression.`;
  }

  private getToneInstructions(): string {
    switch (this.accountabilityStyle) {
      case 'drill_sergeant':
        return `\n\nYour tone is DRILL SERGEANT: direct, blunt, no sugarcoating. Call out laziness. Praise only exceptional effort. Use short, punchy sentences. No pleasantries.`;
      case 'supportive':
        return `\n\nYour tone is SUPPORTIVE: encouraging, empathetic, focus on progress over perfection. Celebrate small wins. Gently point out areas for improvement.`;
      case 'balanced':
        return `\n\nYour tone is BALANCED: honest but fair. Acknowledge good work, directly address problems. Mix encouragement with accountability.`;
    }
  }

  // ── Fallbacks ────────────────────────────────────────────────────

  private fallbackMorningPlan(goals: Goal[]) {
    const overdueGoals = goals.filter(g => g.deadline && g.deadline < Date.now());
    const behindGoals = goals.filter(g => g.health === 'behind' || g.health === 'critical');

    return {
      focus_areas: goals.slice(0, 3).map(g => g.title),
      daily_actions: goals.slice(0, 5).map(g => `Work on: ${g.title}`),
      warnings: [
        ...overdueGoals.map(g => `OVERDUE: ${g.title}`),
        ...behindGoals.map(g => `BEHIND: ${g.title}`),
      ],
      message: overdueGoals.length > 0
        ? 'You have overdue goals. Fix that today.'
        : 'Get to work.',
    };
  }

  private fallbackEveningReview() {
    return {
      score_updates: [],
      actions_completed: [],
      assessment: 'Review completed without LLM analysis.',
      message: 'Check your goals manually.',
    };
  }
}

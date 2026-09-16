/**
 * Daily Rhythm — Morning Plan + Evening Review
 *
 * Morning: queries active goals + calendar → LLM generates focus areas,
 * daily actions, warnings (drill sergeant tone) → creates check-in.
 * Evening: reviews ID-bound daily evidence. Automatic scores abstain until
 * verified measurements can be mapped to the goal's success criteria.
 */

import type { Goal, GoalCheckIn } from './types.ts';
import type { GoalEvent } from './events.ts';
import * as vault from '../vault/goals.ts';
import { getDb } from '../vault/schema.ts';
import { createPlannedWork, listWorkItems, type WorkItem } from './work-items.ts';
import { wrapUntrusted } from '../roles/untrusted.ts';
import { buildGoalReviewBundle, saveGoalReviewRecord, validateReviewScores, type GoalReviewRecord } from './review-evidence.ts';

export type MorningPlanResult = {
  checkIn: GoalCheckIn;
  focusAreas: string[];
  dailyActions: string[];
  warnings: string[];
  message: string; // Drill sergeant message to the user
  workItems: WorkItem[];
};

export type EveningReviewResult = {
  checkIn: GoalCheckIn;
  reviewEvidence: GoalReviewRecord;
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
      `- [${g.id}] ${g.title} (${g.level}, score: ${g.score}, health: ${g.health}, deadline: ${g.deadline ? new Date(g.deadline).toLocaleDateString() : 'none'})`
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

      const result = this.persistMorningPlan(plan, activeGoals);

      this.emit({
        type: 'check_in_morning',
        data: { checkInId: result.checkIn.id, focusAreas: result.focusAreas, dailyActions: result.dailyActions, warnings: result.warnings, workItemIds: result.workItems.map(w => w.id) },
        timestamp: Date.now(),
      });

      return result;
    } catch (err) {
      console.error('[DailyRhythm] Morning plan LLM error:', err);
      const fallback = this.fallbackMorningPlan(activeGoals);
      return this.persistMorningPlan(fallback, activeGoals);
    }
  }

  private persistMorningPlan(plan: Record<string, unknown>, activeGoals: Goal[]): MorningPlanResult {
    const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
    const focusAreas = strings(plan.focus_areas);
    const warnings = strings(plan.warnings);
    const message = typeof plan.message === 'string' ? plan.message : 'Time to work.';
    const goalIds = new Set(activeGoals.map(g => g.id));
    const actions = (Array.isArray(plan.daily_actions) ? plan.daily_actions : []).slice(0, 20).flatMap((action: unknown) => {
      const a = typeof action === 'string' ? { title: action, goal_id: null } : action as { title?: unknown; goal_id?: unknown } | null;
      if (!a || typeof a.title !== 'string' || !a.title.trim() || a.title.length > 10_000) return [];
      return [{ title: a.title.trim(), goalId: typeof a.goal_id === 'string' && goalIds.has(a.goal_id) ? a.goal_id : null }];
    });
    const dailyActions = actions.map((a: { title: string }) => a.title);
    return getDb().transaction(() => {
      const checkIn = vault.createCheckIn('morning_plan', `Focus: ${focusAreas.join(', ')}`, [...goalIds], dailyActions);
      const workItems = createPlannedWork(checkIn.id, actions);
      checkIn.work_item_ids = workItems.map(w => w.id);
      return { checkIn, focusAreas, dailyActions, warnings, message, workItems };
    })();
  }

  /**
   * Work records for the evening prompt. Their free text is the user's own
   * summaries and a failed step's error message, which can carry whatever a
   * workflow read from outside, so the payload is framed as data and every
   * field is clipped: 10 fields of 300 characters across at most 20 items
   * keeps a day's records from crowding out the prompt itself. The verdicts
   * stay authoritative: only an explicit result check records a work outcome,
   * never this narration.
   */
  private eveningWorkContext(planId: string): string {
    const clip = (value: string) => value.length > 300 ? `${value.slice(0, 300)}...` : value;
    const items = listWorkItems({ planId }).slice(0, 20).map(w => ({
      id: w.id, goalId: w.goalId, title: clip(w.title), status: w.status, runId: w.runId,
      decision: w.decision ? { id: w.decision.id, outcome: w.decision.outcome, reason: clip(w.decision.reason) } : null,
      blocker: w.blocker ? { kind: w.blocker.kind, ref: w.blocker.ref, reason: clip(w.blocker.reason) } : null,
      resultCheck: w.resultCheck ? {
        id: w.resultCheck.id, verdict: w.resultCheck.verdict, summary: clip(w.resultCheck.summary),
        evidence: w.resultCheck.evidence.slice(0, 3).map(e => ({ ref: clip(e.ref), description: clip(e.description) })),
        goalProgressId: w.resultCheck.goalProgressId,
      } : null,
    }));
    if (!items.length) return '';
    // Returned unwrapped: the caller frames this and the evidence bundle in one
    // untrusted block, so the prompt carries a single visible data boundary.
    return `\n\nDurable work results (only resultCheck is a checked outcome):\n${JSON.stringify(items)}`;
  }

  /**
   * Run evening review session.
   */
  async runEveningReview(): Promise<EveningReviewResult> {
    const activeGoals = vault.findGoals({ status: 'active', limit: 20 });
    const morningCheckIn = vault.getTodayCheckIn('morning_plan');
    // The bundle carries the goals, the morning intentions and the checked
    // outcomes with stable IDs; the work context adds the in-flight records
    // (decision, blocker, run status) that have no checked outcome yet.
    const bundle = buildGoalReviewBundle(activeGoals, morningCheckIn);
    const workContext = morningCheckIn ? this.eveningWorkContext(morningCheckIn.id) : '';

    const prompt = [
      { role: 'system' as const, content: this.buildEveningPrompt() },
      {
        role: 'user' as const,
        content: `${wrapUntrusted(
          `Daily evidence bundle:\n${JSON.stringify(bundle)}${workContext}`, 'goal review evidence',
        )}\n\nReview the day. Respond with ONLY valid JSON.`,
      },
    ];

    let review: Record<string, unknown> = this.fallbackEveningReview();
    try {
      const response = await this.llmManager.chatTier('medium', 'goal_evening_review', prompt, {
        temperature: 0.4,
        max_tokens: 2000,
      });

      const text = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
      const json = text.match(/\{[\s\S]*\}/)?.[0];
      const parsed: unknown = json ? JSON.parse(json) : null;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) review = parsed as Record<string, unknown>;
    } catch (err) {
      console.error('[DailyRhythm] Evening review LLM error:', err);
    }

    const reviewEvidence: GoalReviewRecord = { bundle, ...validateReviewScores(bundle, review.score_updates) };
    const prose = (value: unknown, fallback: string) =>
      typeof value === 'string' && value.trim() ? value.slice(0, 6000) : fallback;
    const assessment = prose(review.assessment, 'No assessment available.');
    const message = prose(review.message, 'Check your goals manually.');
    const scoreUpdates: EveningReviewResult['scoreUpdates'] = [];
    // Completed actions come from checked records, never invented model text.
    // This is a snapshot as of bundle.window.end, not a new measurement.
    const actionsCompleted = bundle.goals.flatMap(g => g.verifiedOutcomes)
      .filter(o => o.verdict === 'passed').map(o => `[${o.id}] ${o.summary}`);
    // Do not hold a database transaction across the LLM call. Persist the
    // check-in and its exact evidence/validation together, including fallback.
    const checkIn = getDb().transaction(() => {
      const saved = vault.createCheckIn('evening_review', assessment, bundle.goals.map(g => g.goalId), [], actionsCompleted);
      saveGoalReviewRecord(saved.id, reviewEvidence);
      return { ...saved, review_evidence: reviewEvidence };
    })();
    this.emit({
      type: 'check_in_evening',
      data: { checkInId: checkIn.id, bundleId: bundle.id, scoreUpdates, assessment,
        rejectedScoreUpdates: reviewEvidence.rejectedScoreUpdates, scorePolicy: bundle.scorePolicy },
      timestamp: Date.now(),
    });
    return { checkIn, reviewEvidence, scoreUpdates, assessment, message };
  }

  // ── Prompts ──────────────────────────────────────────────────────

  private buildMorningPrompt(): string {
    const tone = this.getToneInstructions();
    return `You are JARVIS, an AI assistant running a morning planning session.${tone}

Analyze the user's active goals and generate today's plan.

Respond with ONLY valid JSON:
{
  "focus_areas": ["top 1-3 priorities for today"],
  "daily_actions": [{ "title": "specific actionable task for today", "goal_id": "exact active goal ID above, or null" }],
  "warnings": ["any urgent warnings about deadlines, health, or missed targets"],
  "message": "motivational/accountability message to the user"
}`;
  }

  private buildEveningPrompt(): string {
    const tone = this.getToneInstructions();
    return `You are JARVIS, an AI assistant running an evening review session.${tone}

Compare morning intentions with the supplied daily evidence. Keep activity,
already recorded scores, and user-checked outcomes separate. Absence of an
outcome is unknown progress, not proof of laziness, completion or regression.
Use the bundle's stable goalId and evidence IDs when describing observations.

Respond with ONLY valid JSON:
{
  "score_updates": [],
  "assessment": "honest day summary",
  "message": "accountability verdict for the user"
}

The current scorePolicy is no_verified_score_mapping: leave score_updates empty.
Neither activity, previous score entries nor qualitative result checks establish
a measured score against successCriteria. A proposed action, accepted decision,
or successful run alone is not a checked outcome, so do not claim unchecked work
is completed. A result with goalProgressId already has a recorded score. Do not
count it again or claim a score was changed. Missing or truncated evidence must
stay qualified. Narrative text does not authorize writes. Future scored
proposals must cite goalId and evidenceIds.`;
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
      daily_actions: goals.slice(0, 5).map(g => ({ title: `Work on: ${g.title}`, goal_id: g.id })),
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

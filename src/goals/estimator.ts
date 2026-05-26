/**
 * Goal Estimator — Hybrid LLM + historical estimation
 *
 * Blends LLM estimates with personal historical data from completed goals.
 * 60/40 split (history/LLM) when history is available, 100% LLM otherwise.
 */

import type { GoalEstimate, GoalLevel } from './types.ts';
import * as vault from '../vault/goals.ts';

export class GoalEstimator {
  private llmManager: any; // LLMManager

  constructor(llmManager: unknown) {
    this.llmManager = llmManager;
  }

  /**
   * Estimate hours for a goal by combining LLM judgment with historical data.
   */
  async estimate(goalId: string): Promise<GoalEstimate | null> {
    const goal = vault.getGoal(goalId);
    if (!goal) return null;

    // Find similar completed goals
    const similarGoals = this.findSimilarCompleted(goal.title, goal.level, goal.description);

    // Get LLM estimate
    const llmEstimate = await this.getLLMEstimate(goal.title, goal.level, goal.description, goal.success_criteria);

    // Calculate historical estimate
    const historicalEstimate = this.calculateHistoricalEstimate(similarGoals);

    // Blend estimates
    let finalEstimate: number;
    let confidence: number;
    let reasoning: string;

    if (historicalEstimate !== null && similarGoals.length >= 2) {
      // 60% history, 40% LLM when we have good historical data
      finalEstimate = historicalEstimate * 0.6 + llmEstimate.hours * 0.4;
      confidence = Math.min(0.9, 0.5 + similarGoals.length * 0.1);
      reasoning = `Blended estimate: ${similarGoals.length} similar past goals averaged ${historicalEstimate.toFixed(1)}h (actual), LLM estimates ${llmEstimate.hours.toFixed(1)}h. ${llmEstimate.reasoning}`;
    } else if (historicalEstimate !== null) {
      // Some history, less weight
      finalEstimate = historicalEstimate * 0.4 + llmEstimate.hours * 0.6;
      confidence = 0.4;
      reasoning = `Limited history (${similarGoals.length} similar goal${similarGoals.length === 1 ? '' : 's'}): ${historicalEstimate.toFixed(1)}h actual. LLM estimates ${llmEstimate.hours.toFixed(1)}h. ${llmEstimate.reasoning}`;
    } else {
      // No history, pure LLM
      finalEstimate = llmEstimate.hours;
      confidence = Math.min(0.5, llmEstimate.confidence);
      reasoning = `No historical data. LLM estimate: ${llmEstimate.reasoning}`;
    }

    return {
      llm_estimate_hours: llmEstimate.hours,
      historical_estimate_hours: historicalEstimate,
      final_estimate_hours: Math.round(finalEstimate * 10) / 10,
      confidence: Math.round(confidence * 100) / 100,
      reasoning,
      similar_past_goals: similarGoals.map(g => g.id),
    };
  }

  /**
   * Quick estimate without LLM — uses only historical data and heuristics.
   */
  quickEstimate(title: string, level: GoalLevel): { hours: number; confidence: number } {
    const similar = this.findSimilarCompleted(title, level);
    const historical = this.calculateHistoricalEstimate(similar);

    if (historical !== null && similar.length >= 2) {
      return { hours: Math.round(historical * 10) / 10, confidence: 0.6 };
    }

    // Heuristic fallback based on level
    const levelDefaults: Record<GoalLevel, number> = {
      objective: 200,
      key_result: 40,
      milestone: 20,
      task: 4,
      daily_action: 1,
    };
    return { hours: levelDefaults[level], confidence: 0.2 };
  }

  // ── Private ──────────────────────────────────────────────────────

  private findSimilarCompleted(title: string, level: GoalLevel, description?: string): ReturnType<typeof vault.findGoals> {
    // Find completed goals at the same level
    const completed = vault.findGoals({ status: 'completed', level, limit: 50 });

    // Score similarity using simple word overlap
    const titleWords = new Set(title.toLowerCase().split(/\s+/).filter(w => w.length > 2));
    const descWords = description
      ? new Set(description.toLowerCase().split(/\s+/).filter(w => w.length > 2))
      : new Set<string>();

    const scored = completed
      .map(goal => {
        const goalWords = new Set([
          ...goal.title.toLowerCase().split(/\s+/).filter(w => w.length > 2),
          ...goal.description.toLowerCase().split(/\s+/).filter(w => w.length > 2),
        ]);

        let overlap = 0;
        for (const word of titleWords) {
          if (goalWords.has(word)) overlap += 2; // Title matches worth more
        }
        for (const word of descWords) {
          if (goalWords.has(word)) overlap += 1;
        }

        return { goal, score: overlap };
      })
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    return scored.map(s => s.goal);
  }

  private calculateHistoricalEstimate(goals: ReturnType<typeof vault.findGoals>): number | null {
    const withHours = goals.filter(g => g.actual_hours > 0);
    if (withHours.length === 0) return null;

    const total = withHours.reduce((sum, g) => sum + g.actual_hours, 0);
    return total / withHours.length;
  }

  private async getLLMEstimate(
    title: string,
    level: GoalLevel,
    description: string,
    successCriteria: string,
  ): Promise<{ hours: number; confidence: number; reasoning: string }> {
    const prompt = [
      {
        role: 'system' as const,
        content: `You are a project estimation expert. Estimate the total hours needed to complete a goal.

Consider:
- Goal level: objective (large), key_result (medium), milestone (small), task (tiny), daily_action (1-2h)
- Include planning, execution, review, and buffer time
- Be realistic, not optimistic

Respond with ONLY valid JSON: { "hours": number, "confidence": number (0-1), "reasoning": "brief explanation" }`,
      },
      {
        role: 'user' as const,
        content: `Estimate hours for:\nLevel: ${level}\nTitle: ${title}\nDescription: ${description}\nSuccess Criteria: ${successCriteria}`,
      },
    ];

    try {
      const response = await this.llmManager.chatTier('low', 'goal_estimator', prompt, {
        temperature: 0.2,
        max_tokens: 500,
      });

      const text = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
      const json = text.match(/\{[\s\S]*\}/)?.[0];
      if (!json) throw new Error('No JSON in response');

      const parsed = JSON.parse(json);
      return {
        hours: Math.max(0.5, Number(parsed.hours) || 4),
        confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0.3)),
        reasoning: String(parsed.reasoning || 'LLM estimate'),
      };
    } catch (err) {
      console.error('[GoalEstimator] LLM estimate failed:', err instanceof Error ? err.message : err);
      // Fallback heuristic
      const defaults: Record<GoalLevel, number> = {
        objective: 200, key_result: 40, milestone: 20, task: 4, daily_action: 1,
      };
      return {
        hours: defaults[level],
        confidence: 0.1,
        reasoning: 'Fallback heuristic (LLM unavailable)',
      };
    }
  }
}

/**
 * Accountability Engine — Drill Sergeant Escalation
 *
 * Staged escalation for goals that are behind or at risk:
 * - Week 1-2: Pressure — daily blunt reminders
 * - Week 3: Root Cause — LLM analyzes why the goal is failing
 * - Week 4+: Suggest Kill — recommend killing or replanning the goal
 *
 * Also generates replan options when goals need course correction.
 */

import type { Goal, EscalationStage } from './types.ts';
import * as vault from '../vault/goals.ts';

export type EscalationAction = {
  goalId: string;
  goalTitle: string;
  currentStage: EscalationStage;
  newStage: EscalationStage;
  message: string;
  weeksBehind: number;
};

export type ReplanOption = {
  id: string;
  label: string;
  description: string;
  impact: 'low' | 'medium' | 'high';
};

export type ReplanAnalysis = {
  options: ReplanOption[];
  analysis: string;
  recommendation: string;
};

export class AccountabilityEngine {
  private llmManager: any; // LLMManager
  private accountabilityStyle: 'drill_sergeant' | 'supportive' | 'balanced';
  private escalationWeeks: { pressure: number; root_cause: number; suggest_kill: number };

  constructor(
    llmManager: unknown,
    style: 'drill_sergeant' | 'supportive' | 'balanced' = 'drill_sergeant',
    escalationWeeks = { pressure: 1, root_cause: 3, suggest_kill: 4 },
  ) {
    this.llmManager = llmManager;
    this.accountabilityStyle = style;
    this.escalationWeeks = escalationWeeks;
  }

  /**
   * Check all active goals and return escalation actions needed.
   */
  runEscalationCheck(): EscalationAction[] {
    const needingEscalation = vault.getGoalsNeedingEscalation();
    const actions: EscalationAction[] = [];

    for (const goal of needingEscalation) {
      const action = this.evaluateEscalation(goal);
      if (action) actions.push(action);
    }

    return actions;
  }

  /**
   * Generate an escalation message for a goal at a given stage.
   */
  async generateEscalationMessage(goal: Goal, stage: EscalationStage): Promise<string> {
    if (stage === 'none') return '';

    const history = vault.getProgressHistory(goal.id, 10);
    const progressContext = history.length > 0
      ? `\nProgress history:\n${history.map(h => `  ${new Date(h.created_at).toLocaleDateString()}: ${h.score_before} → ${h.score_after} (${h.note})`).join('\n')}`
      : '';

    const prompt = [
      {
        role: 'system' as const,
        content: this.getEscalationSystemPrompt(stage),
      },
      {
        role: 'user' as const,
        content: `Goal: ${goal.title}\nLevel: ${goal.level}\nScore: ${goal.score}\nHealth: ${goal.health}\nDeadline: ${goal.deadline ? new Date(goal.deadline).toLocaleDateString() : 'none'}\nStarted: ${goal.started_at ? new Date(goal.started_at).toLocaleDateString() : 'unknown'}${progressContext}\n\nGenerate the escalation message.`,
      },
    ];

    try {
      const response = await this.llmManager.chatTier('medium', 'goal_escalation_message', prompt, {
        temperature: 0.5,
        max_tokens: 500,
      });
      return typeof response.content === 'string' ? response.content : String(response.content);
    } catch {
      return this.getFallbackMessage(goal, stage);
    }
  }

  /**
   * Generate replan options for a struggling goal.
   */
  async generateReplanOptions(goal: Goal): Promise<ReplanAnalysis> {
    const children = vault.getGoalChildren(goal.id);
    const history = vault.getProgressHistory(goal.id, 20);

    const childContext = children.length > 0
      ? `\nChild goals:\n${children.map(c => `- ${c.title} (${c.level}, score: ${c.score}, status: ${c.status})`).join('\n')}`
      : '';

    const historyContext = history.length > 0
      ? `\nRecent progress:\n${history.slice(0, 5).map(h => `  ${h.score_before} → ${h.score_after}: ${h.note}`).join('\n')}`
      : '';

    const prompt = [
      {
        role: 'system' as const,
        content: `You are an OKR coach analyzing a struggling goal. Generate replan options.

Respond with ONLY valid JSON:
{
  "options": [
    { "id": "unique_id", "label": "short label", "description": "what this option means", "impact": "low|medium|high" }
  ],
  "analysis": "why the goal is struggling",
  "recommendation": "which option you recommend and why"
}

Always include these standard options:
- Extend deadline
- Reduce scope
- Change approach
- Kill the goal
Plus 1-2 context-specific options.`,
      },
      {
        role: 'user' as const,
        content: `Goal: ${goal.title}\nDescription: ${goal.description}\nSuccess criteria: ${goal.success_criteria}\nScore: ${goal.score}\nHealth: ${goal.health}\nDeadline: ${goal.deadline ? new Date(goal.deadline).toLocaleDateString() : 'none'}${childContext}${historyContext}`,
      },
    ];

    try {
      const response = await this.llmManager.chatTier('medium', 'goal_replan_options', prompt, {
        temperature: 0.3,
        max_tokens: 1500,
      });

      const text = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
      const json = text.match(/\{[\s\S]*\}/)?.[0];
      if (!json) throw new Error('No JSON in response');

      return JSON.parse(json) as ReplanAnalysis;
    } catch {
      return this.getFallbackReplanOptions(goal);
    }
  }

  // ── Private ──────────────────────────────────────────────────────

  private evaluateEscalation(goal: Goal): EscalationAction | null {
    const startedAt = goal.escalation_started_at ?? goal.updated_at;
    const weeksBehind = (Date.now() - startedAt) / (7 * 24 * 60 * 60 * 1000);

    let newStage: EscalationStage | null = null;

    if (goal.escalation_stage === 'none' && weeksBehind >= this.escalationWeeks.pressure) {
      newStage = 'pressure';
    } else if (goal.escalation_stage === 'pressure') {
      const escalationStart = goal.escalation_started_at ?? goal.updated_at;
      const weeksSinceEscalation = (Date.now() - escalationStart) / (7 * 24 * 60 * 60 * 1000);
      if (weeksSinceEscalation >= this.escalationWeeks.root_cause) {
        newStage = 'root_cause';
      }
    } else if (goal.escalation_stage === 'root_cause') {
      const escalationStart = goal.escalation_started_at ?? goal.updated_at;
      const weeksSinceEscalation = (Date.now() - escalationStart) / (7 * 24 * 60 * 60 * 1000);
      if (weeksSinceEscalation >= this.escalationWeeks.suggest_kill) {
        newStage = 'suggest_kill';
      }
    }

    if (!newStage) return null;

    return {
      goalId: goal.id,
      goalTitle: goal.title,
      currentStage: goal.escalation_stage,
      newStage,
      message: this.getFallbackMessage(goal, newStage),
      weeksBehind: Math.round(weeksBehind * 10) / 10,
    };
  }

  private getEscalationSystemPrompt(stage: EscalationStage): string {
    const tone = this.accountabilityStyle === 'drill_sergeant'
      ? 'Be brutally honest. No sugarcoating. Short, punchy sentences.'
      : this.accountabilityStyle === 'supportive'
        ? 'Be encouraging but honest about the situation.'
        : 'Be direct but fair.';

    switch (stage) {
      case 'pressure':
        return `You are generating a PRESSURE escalation message for a goal that's falling behind. ${tone} Focus on urgency and the consequences of continued inaction. Keep it under 100 words.`;
      case 'root_cause':
        return `You are generating a ROOT CAUSE analysis for a failing goal. ${tone} Identify why this goal is stalling and what needs to change. Keep it under 150 words.`;
      case 'suggest_kill':
        return `You are generating a KILL SUGGESTION for a goal that has been failing for too long. ${tone} Make the case for either killing the goal or doing a major replan. Be direct about sunk cost. Keep it under 150 words.`;
      default:
        return '';
    }
  }

  private getFallbackMessage(goal: Goal, stage: EscalationStage): string {
    switch (stage) {
      case 'pressure':
        return `"${goal.title}" is behind schedule. Score: ${goal.score}. ${goal.deadline ? `Deadline: ${new Date(goal.deadline).toLocaleDateString()}.` : ''} Stop making excuses and deliver.`;
      case 'root_cause':
        return `"${goal.title}" has been behind for weeks. Score: ${goal.score}. Time to figure out what's actually wrong. Is the goal realistic? Are you avoiding something? Fix it or kill it.`;
      case 'suggest_kill':
        return `"${goal.title}" has been failing for over a month. Score: ${goal.score}. Consider killing this goal. Sunk cost is sunk. Either commit to a radical replan or move on.`;
      default:
        return '';
    }
  }

  private getFallbackReplanOptions(goal: Goal): ReplanAnalysis {
    return {
      options: [
        { id: 'extend', label: 'Extend deadline', description: 'Push the deadline back 2-4 weeks', impact: 'low' },
        { id: 'reduce', label: 'Reduce scope', description: 'Cut non-essential success criteria', impact: 'medium' },
        { id: 'pivot', label: 'Change approach', description: 'Try a fundamentally different strategy', impact: 'high' },
        { id: 'kill', label: 'Kill the goal', description: 'Accept the loss and reallocate effort', impact: 'high' },
      ],
      analysis: `"${goal.title}" has a score of ${goal.score} and is ${goal.health}. The current approach isn't working.`,
      recommendation: goal.score < 0.2
        ? 'Consider killing this goal or making a major pivot.'
        : 'Extend the deadline and reduce scope to focus on the most impactful parts.',
    };
  }
}

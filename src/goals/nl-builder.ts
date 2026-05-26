/**
 * NL Goal Builder — Natural language to OKR decomposition
 *
 * Converts freeform user descriptions into structured goal hierarchies.
 * Supports iterative refinement via chat, and full decomposition to daily actions.
 */

import type { Goal, GoalLevel } from './types.ts';
import * as vault from '../vault/goals.ts';

type ChatMessage = { role: 'user' | 'assistant'; content: string };

export type GoalProposal = {
  objective: {
    title: string;
    description: string;
    success_criteria: string;
    time_horizon: string;
    deadline_days?: number;
    tags?: string[];
  };
  key_results: {
    title: string;
    description: string;
    success_criteria: string;
    deadline_days?: number;
  }[];
  milestones?: {
    key_result_index: number;
    title: string;
    description: string;
    deadline_days?: number;
  }[];
  clarifying_questions?: string[];
};

export class NLGoalBuilder {
  private llmManager: any; // LLMManager

  constructor(llmManager: unknown) {
    this.llmManager = llmManager;
  }

  /**
   * Parse a natural language goal description into a structured OKR proposal.
   */
  async parseGoal(text: string): Promise<GoalProposal> {
    const existingGoals = vault.getRootGoals().slice(0, 10);
    const existingContext = existingGoals.length > 0
      ? `\n\nExisting goals for context (avoid duplicates):\n${existingGoals.map(g => `- ${g.title} (${g.level}, ${g.status})`).join('\n')}`
      : '';

    const prompt = [
      { role: 'system' as const, content: this.buildSystemPrompt() },
      {
        role: 'user' as const,
        content: `Convert this into an OKR goal hierarchy:\n\n"${text}"${existingContext}\n\nRespond with ONLY valid JSON matching the GoalProposal schema. No explanation.`,
      },
    ];

    const response = await this.llmManager.chatTier('medium', 'nl_goal_builder', prompt, {
      temperature: 0.3,
      max_tokens: 4000,
    });

    return this.parseResponse(response.content);
  }

  /**
   * Decompose an existing goal into child goals at the next level.
   */
  async decompose(goalId: string, depth: GoalLevel = 'task'): Promise<GoalProposal | null> {
    const goal = vault.getGoal(goalId);
    if (!goal) return null;

    const children = vault.getGoalChildren(goalId);
    const childContext = children.length > 0
      ? `\nExisting children:\n${children.map(c => `- ${c.title} (${c.level})`).join('\n')}`
      : '';

    const nextLevel = this.getNextLevel(goal.level);
    if (!nextLevel) return null;

    const prompt = [
      { role: 'system' as const, content: this.buildSystemPrompt() },
      {
        role: 'user' as const,
        content: `Decompose this ${goal.level} into ${nextLevel}s:\n\nTitle: ${goal.title}\nDescription: ${goal.description}\nSuccess criteria: ${goal.success_criteria}\nTime horizon: ${goal.time_horizon}${childContext}\n\nTarget depth: ${depth}\n\nRespond with ONLY valid JSON matching the GoalProposal schema (use key_results array for the sub-goals regardless of level). No explanation.`,
      },
    ];

    const response = await this.llmManager.chatTier('medium', 'nl_goal_builder', prompt, {
      temperature: 0.3,
      max_tokens: 4000,
    });

    return this.parseResponse(response.content);
  }

  /**
   * Conversational goal refinement — chat with history to iteratively build goals.
   */
  async chat(
    goalId: string,
    message: string,
    history: ChatMessage[],
  ): Promise<{ reply: string; proposal?: GoalProposal }> {
    const goal = vault.getGoal(goalId);
    const tree = goal ? vault.getGoalTree(goalId) : [];

    const treeContext = tree.length > 0
      ? `\nCurrent goal tree:\n${tree.map(g => `${'  '.repeat(this.levelDepth(g.level))}${g.title} (${g.level}, score: ${g.score}, status: ${g.status})`).join('\n')}`
      : '';

    const messages = [
      { role: 'system' as const, content: this.buildChatPrompt(treeContext) },
      ...history.map(h => ({ role: h.role as 'user' | 'assistant', content: h.content })),
      { role: 'user' as const, content: message },
    ];

    const response = await this.llmManager.chatTier('medium', 'nl_goal_chat', messages, {
      temperature: 0.4,
      max_tokens: 3000,
    });

    const content = typeof response.content === 'string' ? response.content : '';

    // Check if response contains a JSON proposal
    const jsonMatch = content.match(/```json\n([\s\S]*?)\n```/);
    if (jsonMatch) {
      try {
        const proposal = JSON.parse(jsonMatch[1]) as GoalProposal;
        const textBefore = content.slice(0, content.indexOf('```json')).trim();
        return { reply: textBefore || 'Here is the updated proposal:', proposal };
      } catch { /* not valid JSON, treat as text */ }
    }

    return { reply: content };
  }

  /**
   * Create goal hierarchy from a confirmed proposal.
   */
  createFromProposal(proposal: GoalProposal, parentId?: string): Goal[] {
    const created: Goal[] = [];

    const objective = vault.createGoal(proposal.objective.title, 'objective', {
      parent_id: parentId,
      description: proposal.objective.description,
      success_criteria: proposal.objective.success_criteria,
      time_horizon: proposal.objective.time_horizon as any,
      deadline: proposal.objective.deadline_days
        ? Date.now() + proposal.objective.deadline_days * 86400000
        : undefined,
      tags: proposal.objective.tags,
    });
    created.push(objective);

    for (let i = 0; i < proposal.key_results.length; i++) {
      const kr = proposal.key_results[i]!;
      const keyResult = vault.createGoal(kr.title, 'key_result', {
        parent_id: objective.id,
        description: kr.description,
        success_criteria: kr.success_criteria,
        deadline: kr.deadline_days
          ? Date.now() + kr.deadline_days * 86400000
          : undefined,
      });
      created.push(keyResult);

      // Add milestones under their key results
      if (proposal.milestones) {
        for (const ms of proposal.milestones) {
          if (ms.key_result_index === i) {
            const milestone = vault.createGoal(ms.title, 'milestone', {
              parent_id: keyResult.id,
              description: ms.description,
              deadline: ms.deadline_days
                ? Date.now() + ms.deadline_days * 86400000
                : undefined,
            });
            created.push(milestone);
          }
        }
      }
    }

    return created;
  }

  // ── Helpers ──────────────────────────────────────────────────────

  private buildSystemPrompt(): string {
    return `You are an OKR (Objectives and Key Results) expert using Google-style scoring (0.0-1.0 scale, where 0.7 = good, 1.0 = aimed too low).

Rules:
- Objectives are qualitative, ambitious, and inspiring
- Key Results are specific, measurable, and time-bound
- Milestones break Key Results into concrete deliverables
- Tasks are actionable work items
- Daily Actions are single-day activities
- Goal hierarchy: objective → key_result → milestone → task → daily_action
- Time horizons: life, yearly, quarterly, monthly, weekly, daily
- Be specific with success criteria — use numbers, dates, concrete outcomes
- Create 2-5 Key Results per Objective
- Create 1-3 Milestones per Key Result when appropriate

Respond with ONLY valid JSON matching this schema:
{
  "objective": { "title": string, "description": string, "success_criteria": string, "time_horizon": string, "deadline_days?": number, "tags?": string[] },
  "key_results": [{ "title": string, "description": string, "success_criteria": string, "deadline_days?": number }],
  "milestones?": [{ "key_result_index": number, "title": string, "description": string, "deadline_days?": number }],
  "clarifying_questions?": string[]
}`;
  }

  private buildChatPrompt(treeContext: string): string {
    return `You are an OKR coach helping refine goals. Be direct and constructive.${treeContext}

When the user wants to change goals, include a JSON proposal in a \`\`\`json code block. Otherwise, respond conversationally with advice and questions.`;
  }

  private parseResponse(content: string | unknown): GoalProposal {
    const text = typeof content === 'string' ? content : JSON.stringify(content);
    const json = this.extractJson(text);
    return JSON.parse(json) as GoalProposal;
  }

  private extractJson(text: string): string {
    // Try code block first
    const codeBlock = text.match(/```(?:json)?\n?([\s\S]*?)\n?```/);
    if (codeBlock) return codeBlock[1]!;

    // Try raw JSON
    const jsonStart = text.indexOf('{');
    const jsonEnd = text.lastIndexOf('}');
    if (jsonStart !== -1 && jsonEnd > jsonStart) {
      return text.slice(jsonStart, jsonEnd + 1);
    }

    return text;
  }

  private getNextLevel(level: GoalLevel): GoalLevel | null {
    const order: GoalLevel[] = ['objective', 'key_result', 'milestone', 'task', 'daily_action'];
    const idx = order.indexOf(level);
    return idx < order.length - 1 ? order[idx + 1]! : null;
  }

  private levelDepth(level: GoalLevel): number {
    const depths: Record<GoalLevel, number> = {
      objective: 0, key_result: 1, milestone: 2, task: 3, daily_action: 4,
    };
    return depths[level];
  }
}

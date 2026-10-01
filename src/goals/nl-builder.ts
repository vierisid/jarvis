/**
 * NL Goal Builder — Natural language to OKR decomposition
 *
 * Converts freeform user descriptions into structured goal hierarchies.
 * Supports iterative refinement via chat, and full decomposition to daily actions.
 */

import type { Goal, GoalLevel } from './types.ts';
import * as vault from '../vault/goals.ts';
import { getGoalApplication } from './application-service.ts';
import { planProposal, validateProposal, type GoalProposal } from './proposal.ts';
import { enumeration, GOAL_LEVELS, invalid, nextGoalLevel, text as goalText, timezone } from './validation.ts';
export type { GoalProposal } from './proposal.ts';

type ChatMessage = { role: 'user' | 'assistant'; content: string };

export class NLGoalBuilder {
  private llmManager: any; // LLMManager

  private readonly timeZone: string;

  constructor(llmManager: unknown, options: { timezone?: string } = {}) {
    this.llmManager = llmManager;
    this.timeZone = timezone(options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  }

  /**
   * Parse a natural language goal description into a structured OKR proposal.
   */
  async parseGoal(text: string, parentId?: string): Promise<GoalProposal> {
    goalText(text, 'text');
    const parent = this.resolveParent(parentId);
    if (parent && !nextGoalLevel(parent.level)) invalid('parent_id', 'a daily_action cannot have children');
    const reference = Date.now();
    const existingGoals = vault.getRootGoals().slice(0, 10);
    const existingContext = existingGoals.length > 0
      ? `\n\nExisting goals for context (avoid duplicates):\n${existingGoals.map(g => `- ${g.title} (${g.level}, ${g.status})`).join('\n')}`
      : '';

    const prompt = [
      { role: 'system' as const, content: this.buildSystemPrompt(reference) },
      {
        role: 'user' as const,
        content: `Convert this into an OKR goal hierarchy:\n\n"${text}"${existingContext}\n\nRespond with ONLY valid JSON matching the GoalProposal schema. ${parent ? `Use objective only as context for existing ${parent.level} ${parent.id} (${parent.title}; ${parent.description}; deadline ${parent.deadline === null ? 'none' : new Date(parent.deadline).toISOString()}); key_results are its ${nextGoalLevel(parent.level)} children.` : 'Create one new root objective.'} No explanation.`,
      },
    ];

    const response = await this.llmManager.chatTier('medium', 'nl_goal_builder', prompt, {
      temperature: 0.3,
      max_tokens: 4000,
    });

    return this.parseResponse(response.content, parent, reference);
  }

  /**
   * Decompose an existing goal into child goals at the next level.
   */
  async decompose(goalId: string, depth: GoalLevel = 'daily_action'): Promise<GoalProposal | null> {
    const goal = vault.getGoal(goalId);
    if (!goal) return null;

    const children = vault.getGoalChildren(goalId);
    const childContext = children.length > 0
      ? `\nExisting children:\n${children.map(c => `- ${c.title} (${c.level})`).join('\n')}`
      : '';

    const nextLevel = nextGoalLevel(goal.level);
    if (!nextLevel) return null;
    enumeration(depth, GOAL_LEVELS, 'depth');
    if (GOAL_LEVELS.indexOf(depth) < GOAL_LEVELS.indexOf(nextLevel)) invalid('depth', 'must be below the parent');
    const reference = Date.now();

    const prompt = [
      { role: 'system' as const, content: this.buildSystemPrompt(reference) },
      {
        role: 'user' as const,
        content: `Decompose this ${goal.level} into ${nextLevel}s:\n\nTitle: ${goal.title}\nDescription: ${goal.description}\nSuccess criteria: ${goal.success_criteria}\nTime horizon: ${goal.time_horizon}\nDeadline: ${goal.deadline === null ? 'none' : new Date(goal.deadline).toISOString()}${childContext}\n\nTarget depth: ${depth}\n\nRespond with ONLY valid JSON matching the GoalProposal schema (use key_results array for the sub-goals regardless of level). No explanation.`,
      },
    ];

    const response = await this.llmManager.chatTier('medium', 'nl_goal_builder', prompt, {
      temperature: 0.3,
      max_tokens: 4000,
    });

    const proposal = this.parseResponse(response.content, goal, reference);
    if (depth === nextLevel && proposal.milestones?.length) invalid('milestones', 'exceeds the requested depth');
    return proposal;
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
    const reference = Date.now();
    const tree = goal ? vault.getGoalTree(goalId) : [];

    const treeContext = tree.length > 0
      ? `\nCurrent goal tree:\n${tree.map(g => `${'  '.repeat(this.levelDepth(g.level))}${g.title} (${g.level}, score: ${g.score}, status: ${g.status})`).join('\n')}`
      : '';

    const messages = [
      { role: 'system' as const, content: this.buildSystemPrompt(reference, false) + '\n\n' + this.buildChatPrompt(treeContext) },
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
        const proposal = this.parseResponse(jsonMatch[1], goal, reference);
        const textBefore = content.slice(0, content.indexOf('```json')).trim();
        return { reply: textBefore || 'Here is the updated proposal:', proposal };
      } catch { /* not valid JSON, treat as text */ }
    }

    return { reply: content };
  }

  /**
   * Create goal hierarchy from a confirmed proposal.
   */
  createFromProposal(input: unknown, parentId?: string): Goal[] {
    return getGoalApplication().createFromProposal(input, parentId);
  }

  private resolveParent(parentId?: string): Goal | null {
    if (parentId === undefined) return null;
    goalText(parentId, 'parent_id', true, 512);
    const parent = vault.getGoal(parentId);
    if (!parent) invalid('parent_id', 'goal does not exist');
    return parent;
  }

  // ── Helpers ──────────────────────────────────────────────────────

  private buildSystemPrompt(reference: number, jsonOnly = true): string {
    return `You are an OKR (Objectives and Key Results) expert using Google-style scoring (0.0-1.0 scale, where 0.7 = good, 1.0 = aimed too low).

Reference instant: ${new Date(reference).toISOString()}. User timezone: ${this.timeZone}.
Dates: deadline_days is a nonnegative integer of elapsed 24-hour periods from this reference (0 means this instant), not calendar days. For a calendar date/local deadline, use deadline_at as a real RFC3339 timestamp with seconds and explicit Z/offset in the user's timezone. Do not output date-only or timezone-less timestamps. Use only one deadline field per goal. Children cannot be due after their ancestors. Jarvis attaches the reference/timezone and parent identity; do not invent those metadata fields.
For decomposition, objective is context only, key_results holds the next level, and milestones holds the following level. Never put children below daily_action. The schema represents at most two child levels per request.

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

${jsonOnly ? 'Respond with ONLY valid JSON matching this schema.' : 'When proposing goals, use this schema in a json code block.'}
Optional fields: deadline_days, deadline_at, tags, milestones, clarifying_questions. Omit optional fields when unused.
{
  "objective": { "title": string, "description": string, "success_criteria": string, "time_horizon": string, "deadline_days": number, "deadline_at": string, "tags": string[] },
  "key_results": [{ "title": string, "description": string, "success_criteria": string, "deadline_days": number, "deadline_at": string }],
  "milestones": [{ "key_result_index": number, "title": string, "description": string, "deadline_days": number, "deadline_at": string }],
  "clarifying_questions": string[]
}`;
  }

  private buildChatPrompt(treeContext: string): string {
    return `You are an OKR coach helping refine goals. Be direct and constructive.${treeContext}

When the user wants to change goals, include a JSON proposal in a \`\`\`json code block. Otherwise, respond conversationally with advice and questions.`;
  }

  private parseResponse(content: unknown, parent: Goal | null, reference: number): GoalProposal {
    let raw = content;
    if (typeof content === 'string') {
      try { raw = JSON.parse(content); }
      catch { raw = JSON.parse(this.extractJson(content)); }
    }
    const proposal = validateProposal(raw);
    if (proposal.parent_id !== undefined && (proposal.parent_id !== parent?.id || proposal.parent_level !== parent?.level)) invalid('parent_id', 'model proposal does not match the requested parent');
    proposal.deadline_reference_at = new Date(reference).toISOString();
    proposal.timezone = this.timeZone;
    if (parent) { proposal.parent_id = parent.id; proposal.parent_level = parent.level; }
    // Questions can be displayed, but createFromProposal refuses to write until resolved.
    planProposal({ ...proposal, clarifying_questions: [] }, parent, reference);
    return proposal;
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

  private levelDepth(level: GoalLevel): number {
    const depths: Record<GoalLevel, number> = {
      objective: 0, key_result: 1, milestone: 2, task: 3, daily_action: 4,
    };
    return depths[level];
  }
}

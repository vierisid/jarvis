/**
 * Manage Goals Tool — Chat-Driven Goal Pursuit
 *
 * Allows the agent to create, list, score, update, decompose, replan,
 * and run daily rhythm from natural language chat.
 */

import type { ToolDefinition } from './registry.ts';
import type { GoalService } from '../../goals/service.ts';
import type { NLGoalBuilder } from '../../goals/nl-builder.ts';
import type { GoalEstimator } from '../../goals/estimator.ts';
import type { DailyRhythm } from '../../goals/rhythm.ts';
import type { AccountabilityEngine } from '../../goals/accountability.ts';
import * as vault from '../../vault/goals.ts';

export type GoalToolDeps = {
  goalService: GoalService;
  nlBuilder: NLGoalBuilder;
  estimator: GoalEstimator;
  rhythm: DailyRhythm;
  accountability: AccountabilityEngine;
};

export function createManageGoalsTool(deps: GoalToolDeps): ToolDefinition {
  return {
    name: 'manage_goals',
    description: [
      'Manage OKR-style goals: a hierarchy from objective down to daily_action, scored 0.0-1.0.',
      'Google-style scoring: 0.7 = good, 1.0 = aimed too low.',
      'For one-off tasks with a due date, use commitments instead.',
    ].join('\n'),
    category: 'goals',
    parameters: {
      action: {
        type: 'string',
        description: 'What to do.',
        enum: ['create', 'list', 'get', 'score', 'update_status', 'update', 'decompose', 'replan', 'estimate', 'morning_plan', 'evening_review', 'metrics', 'delete', 'tree', 'overdue', 'escalations'],
        required: true,
      },
      text: {
        type: 'string',
        description: 'Natural-language goal, for create.',
        required: false,
      },
      goal_id: {
        type: 'string',
        description: 'Target goal ID',
        required: false,
      },
      score: {
        type: 'number',
        description: '0.0-1.0, for score.',
        required: false,
      },
      reason: {
        type: 'string',
        description: 'Reason for score update',
        required: false,
      },
      status: {
        type: 'string',
        description: 'New status for update_status: draft, active, paused, completed, failed, killed.',
        required: false,
      },
      title: {
        type: 'string',
        description: 'Title, for a quick create without text.',
        required: false,
      },
      level: {
        type: 'string',
        description: 'Goal level: objective, key_result, milestone, task, daily_action.',
        required: false,
      },
      parent_id: {
        type: 'string',
        description: 'Parent goal id, for create.',
        required: false,
      },
      filter_status: {
        type: 'string',
        description: 'Filter list by status.',
        required: false,
      },
      filter_level: {
        type: 'string',
        description: 'Filter list by level.',
        required: false,
      },
      limit: {
        type: 'number',
        description: 'Max results for list.',
        required: false,
      },
    },
    execute: async (params) => {
      const action = String(params.action ?? '').toLowerCase();

      switch (action) {
        case 'create': {
          const text = params.text as string | undefined;
          const title = params.title as string | undefined;

          if (text) {
            // NL goal creation
            try {
              const proposal = await deps.nlBuilder.parseGoal(text);

              if (proposal.clarifying_questions?.length) {
                return `Before creating this goal, I have some questions:\n${proposal.clarifying_questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}\n\nPlease answer these and I'll create the full OKR breakdown.`;
              }

              const goals = deps.nlBuilder.createFromProposal(
                proposal,
                params.parent_id as string | undefined,
              );

              const summary = goals.map(g =>
                `${'  '.repeat(levelDepth(g.level))}${g.level}: ${g.title}`
              ).join('\n');

              return `Created ${goals.length} goals:\n${summary}`;
            } catch (err) {
              return `Error creating goal from NL: ${err instanceof Error ? err.message : err}`;
            }
          }

          if (title) {
            // Quick creation
            const level = (params.level as string) ?? 'task';
            const goal = deps.goalService.createGoal(title, level as any, {
              parent_id: params.parent_id as string | undefined,
            });
            return `Created ${level}: "${goal.title}" (${goal.id})`;
          }

          return 'Error: Provide either "text" (NL description) or "title" (quick create).';
        }

        case 'list': {
          const goals = vault.findGoals({
            status: params.filter_status as any,
            level: params.filter_level as any,
            limit: params.limit as number ?? 20,
          });

          if (goals.length === 0) return 'No goals found matching filters.';

          return goals.map(g =>
            `[${g.status}] ${g.title} (${g.level}, score: ${g.score}, health: ${g.health})` +
            (g.deadline ? ` — due ${new Date(g.deadline).toLocaleDateString()}` : '')
          ).join('\n');
        }

        case 'get': {
          const goalId = params.goal_id as string;
          if (!goalId) return 'Error: "goal_id" is required.';

          const goal = vault.getGoal(goalId);
          if (!goal) return `Goal "${goalId}" not found.`;

          const children = vault.getGoalChildren(goalId);
          const progress = vault.getProgressHistory(goalId, 5);

          let result = `**${goal.title}**\n`;
          result += `Level: ${goal.level} | Status: ${goal.status} | Health: ${goal.health}\n`;
          result += `Score: ${goal.score}${goal.score_reason ? ` (${goal.score_reason})` : ''}\n`;
          result += `Time horizon: ${goal.time_horizon}\n`;
          if (goal.description) result += `Description: ${goal.description}\n`;
          if (goal.success_criteria) result += `Success criteria: ${goal.success_criteria}\n`;
          if (goal.deadline) result += `Deadline: ${new Date(goal.deadline).toLocaleDateString()}\n`;
          if (goal.tags.length) result += `Tags: ${goal.tags.join(', ')}\n`;
          if (goal.escalation_stage !== 'none') result += `Escalation: ${goal.escalation_stage}\n`;

          if (children.length > 0) {
            result += `\nChildren (${children.length}):\n`;
            result += children.map(c => `  - ${c.title} (${c.level}, ${c.score})`).join('\n');
          }

          if (progress.length > 0) {
            result += `\nRecent progress:\n`;
            result += progress.map(p =>
              `  ${new Date(p.created_at).toLocaleDateString()}: ${p.score_before} → ${p.score_after} (${p.note})`
            ).join('\n');
          }

          return result;
        }

        case 'score': {
          const goalId = params.goal_id as string;
          const score = params.score as number;
          const reason = (params.reason as string) ?? '';
          if (!goalId) return 'Error: "goal_id" is required.';
          if (score === undefined || score === null) return 'Error: "score" is required (0.0-1.0).';

          const goal = deps.goalService.scoreGoal(goalId, score, reason);
          if (!goal) return `Goal "${goalId}" not found.`;
          return `Updated score for "${goal.title}": ${goal.score} — ${reason}`;
        }

        case 'update_status': {
          const goalId = params.goal_id as string;
          const status = params.status as string;
          if (!goalId) return 'Error: "goal_id" is required.';
          if (!status) return 'Error: "status" is required.';

          const goal = deps.goalService.updateStatus(goalId, status as any);
          if (!goal) return `Goal "${goalId}" not found.`;
          return `Updated "${goal.title}" status to: ${goal.status}`;
        }

        case 'update': {
          const goalId = params.goal_id as string;
          if (!goalId) return 'Error: "goal_id" is required.';

          const updates: Record<string, unknown> = {};
          if (params.title) updates.title = params.title;
          if (params.reason) updates.description = params.reason; // overloaded field

          const goal = deps.goalService.updateGoal(goalId, updates as any);
          if (!goal) return `Goal "${goalId}" not found.`;
          return `Updated "${goal.title}".`;
        }

        case 'decompose': {
          const goalId = params.goal_id as string;
          if (!goalId) return 'Error: "goal_id" is required.';

          try {
            const proposal = await deps.nlBuilder.decompose(goalId);
            if (!proposal) return 'Could not decompose — goal not found or already at lowest level.';

            const goals = deps.nlBuilder.createFromProposal(proposal, goalId);
            const summary = goals.map(g =>
              `${'  '.repeat(levelDepth(g.level))}${g.level}: ${g.title}`
            ).join('\n');
            return `Decomposed into ${goals.length} sub-goals:\n${summary}`;
          } catch (err) {
            return `Decomposition error: ${err instanceof Error ? err.message : err}`;
          }
        }

        case 'replan': {
          const goalId = params.goal_id as string;
          if (!goalId) return 'Error: "goal_id" is required.';

          const goal = vault.getGoal(goalId);
          if (!goal) return `Goal "${goalId}" not found.`;

          try {
            const analysis = await deps.accountability.generateReplanOptions(goal);
            let result = `**Replan Analysis: ${goal.title}**\n\n`;
            result += `Analysis: ${analysis.analysis}\n\n`;
            result += `Options:\n`;
            for (const opt of analysis.options) {
              result += `  [${opt.impact.toUpperCase()}] ${opt.label}: ${opt.description}\n`;
            }
            result += `\nRecommendation: ${analysis.recommendation}`;
            return result;
          } catch (err) {
            return `Replan error: ${err instanceof Error ? err.message : err}`;
          }
        }

        case 'estimate': {
          const goalId = params.goal_id as string;
          if (!goalId) return 'Error: "goal_id" is required.';

          try {
            const estimate = await deps.estimator.estimate(goalId);
            if (!estimate) return `Goal "${goalId}" not found.`;

            return `**Estimate:** ${estimate.final_estimate_hours}h (confidence: ${(estimate.confidence * 100).toFixed(0)}%)\n` +
              `LLM: ${estimate.llm_estimate_hours}h | Historical: ${estimate.historical_estimate_hours ?? 'N/A'}h\n` +
              `${estimate.reasoning}` +
              (estimate.similar_past_goals.length > 0
                ? `\nBased on ${estimate.similar_past_goals.length} similar past goal(s)`
                : '');
          } catch (err) {
            return `Estimation error: ${err instanceof Error ? err.message : err}`;
          }
        }

        case 'morning_plan': {
          try {
            const result = await deps.rhythm.runMorningPlan();
            let output = `**Morning Plan**\n\n`;
            output += `${result.message}\n\n`;
            if (result.warnings.length) {
              output += `Warnings:\n${result.warnings.map(w => `  ⚠ ${w}`).join('\n')}\n\n`;
            }
            output += `Focus areas:\n${result.focusAreas.map(f => `  → ${f}`).join('\n')}\n\n`;
            output += `Today's actions:\n${result.dailyActions.map(a => `  □ ${a}`).join('\n')}`;
            return output;
          } catch (err) {
            return `Morning plan error: ${err instanceof Error ? err.message : err}`;
          }
        }

        case 'evening_review': {
          try {
            const result = await deps.rhythm.runEveningReview();
            let output = `**Evening Review**\n\n`;
            output += `${result.message}\n\n`;
            output += `Assessment: ${result.assessment}\n`;
            if (result.scoreUpdates.length) {
              output += `\nScore updates:\n${result.scoreUpdates.map(s => `  ${s.goalId}: ${s.newScore} — ${s.reason}`).join('\n')}`;
            }
            return output;
          } catch (err) {
            return `Evening review error: ${err instanceof Error ? err.message : err}`;
          }
        }

        case 'metrics': {
          const m = deps.goalService.getMetrics();
          return `**Goal Metrics**\n` +
            `Total: ${m.total} | Active: ${m.active} | Completed: ${m.completed}\n` +
            `Failed: ${m.failed} | Killed: ${m.killed}\n` +
            `Avg OKR Score: ${m.avg_score.toFixed(2)}\n` +
            `On Track: ${m.on_track} | At Risk: ${m.at_risk} | Behind: ${m.behind} | Critical: ${m.critical}\n` +
            `Overdue: ${m.overdue}`;
        }

        case 'delete': {
          const goalId = params.goal_id as string;
          if (!goalId) return 'Error: "goal_id" is required.';
          const deleted = deps.goalService.deleteGoal(goalId);
          return deleted ? `Goal deleted (and all children).` : `Goal "${goalId}" not found.`;
        }

        case 'tree': {
          const goalId = params.goal_id as string;
          if (!goalId) return 'Error: "goal_id" is required.';

          const tree = vault.getGoalTree(goalId);
          if (tree.length === 0) return `Goal "${goalId}" not found.`;

          return tree.map(g =>
            `${'  '.repeat(levelDepth(g.level))}[${g.status}] ${g.title} (${g.level}, ${g.score})`
          ).join('\n');
        }

        case 'overdue': {
          const overdue = vault.getOverdueGoals();
          if (overdue.length === 0) return 'No overdue goals. Keep it up.';
          return `**${overdue.length} Overdue Goal(s):**\n` +
            overdue.map(g =>
              `  ${g.title} — due ${new Date(g.deadline!).toLocaleDateString()} (score: ${g.score})`
            ).join('\n');
        }

        case 'escalations': {
          const actions = deps.accountability.runEscalationCheck();
          if (actions.length === 0) return 'No goals need escalation right now.';
          return `**${actions.length} Escalation(s) Needed:**\n` +
            actions.map(a =>
              `  ${a.goalTitle}: ${a.currentStage} → ${a.newStage} (${a.weeksBehind} weeks behind)\n    ${a.message}`
            ).join('\n\n');
        }

        default:
          return `Unknown action "${action}". Available: create, list, get, score, update_status, update, decompose, replan, estimate, morning_plan, evening_review, metrics, delete, tree, overdue, escalations`;
      }
    },
  };
}

function levelDepth(level: string): number {
  const depths: Record<string, number> = {
    objective: 0, key_result: 1, milestone: 2, task: 3, daily_action: 4,
  };
  return depths[level] ?? 0;
}

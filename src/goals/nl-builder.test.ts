import { test, expect, describe, beforeEach } from 'bun:test';
import { initDatabase } from '../vault/schema.ts';
import { NLGoalBuilder, type GoalProposal } from './nl-builder.ts';
import { GoalEstimator } from './estimator.ts';
import * as vault from '../vault/goals.ts';

// Mock LLM manager - returns canned responses. chatTier delegates to chat
// so the tier-routing migration is transparent to these tests.
const mockLLM: any = {
  chatTier: async (_tier: string, _sub: string, messages: any[], opts?: any) =>
    mockLLM.chat(messages, opts),
  chat: async (messages: any[], _opts?: any) => {
    const lastMsg = messages[messages.length - 1];
    const content = typeof lastMsg.content === 'string' ? lastMsg.content : '';

    // Default proposal response
    if (content.includes('Convert this into an OKR') || content.includes('Decompose this')) {
      return {
        content: JSON.stringify({
          objective: {
            title: 'Ship MVP',
            description: 'Launch the minimum viable product',
            success_criteria: '100 active users within 30 days of launch',
            time_horizon: 'quarterly',
            deadline_days: 90,
            tags: ['product', 'launch'],
          },
          key_results: [
            {
              title: 'Complete core features',
              description: 'Build all must-have features',
              success_criteria: '5 core features deployed and tested',
              deadline_days: 60,
            },
            {
              title: 'Launch marketing site',
              description: 'Build and deploy landing page',
              success_criteria: 'Site live with signup form',
              deadline_days: 45,
            },
          ],
          milestones: [
            {
              key_result_index: 0,
              title: 'Auth system complete',
              description: 'User registration and login working',
              deadline_days: 30,
            },
          ],
        }),
      };
    }

    // Estimation response
    if (content.includes('Estimate hours')) {
      return {
        content: JSON.stringify({
          hours: 40,
          confidence: 0.6,
          reasoning: 'Medium complexity project with standard web stack',
        }),
      };
    }

    // Chat response
    return { content: 'Here are some suggestions for improving your goal.' };
  },
};

describe('NLGoalBuilder', () => {
  let builder: NLGoalBuilder;

  beforeEach(() => {
    initDatabase(':memory:');
    builder = new NLGoalBuilder(mockLLM);
  });

  test('parseGoal returns structured proposal', async () => {
    const proposal = await builder.parseGoal('I want to ship my MVP this quarter');

    expect(proposal.objective.title).toBe('Ship MVP');
    expect(proposal.key_results.length).toBe(2);
    expect(proposal.milestones?.length).toBe(1);
    expect(proposal.objective.tags).toEqual(['product', 'launch']);
  });

  test('createFromProposal creates goal hierarchy', async () => {
    const proposal = await builder.parseGoal('Ship MVP');
    const goals = builder.createFromProposal(proposal);

    expect(goals.length).toBe(4); // 1 objective + 2 key results + 1 milestone

    // Goals created in order: objective, KR1, milestone (under KR1), KR2
    expect(goals[0]!.level).toBe('objective');
    expect(goals[0]!.title).toBe('Ship MVP');
    expect(goals[1]!.level).toBe('key_result');
    expect(goals[1]!.parent_id).toBe(goals[0]!.id);
    expect(goals[2]!.level).toBe('milestone');
    expect(goals[2]!.parent_id).toBe(goals[1]!.id); // Under first KR
    expect(goals[3]!.level).toBe('key_result');
    expect(goals[3]!.parent_id).toBe(goals[0]!.id);
  });

  test('createFromProposal with parent_id', async () => {
    const parent = vault.createGoal('Parent Objective', 'objective');
    const proposal = await builder.parseGoal('Sub-objective');
    const goals = builder.createFromProposal(proposal, parent.id);

    expect(goals[0]!.parent_id).toBe(parent.id);
  });

  test('decompose returns proposal for children', async () => {
    const goal = vault.createGoal('Root Objective', 'objective', {
      description: 'A big goal',
      success_criteria: 'It works',
    });

    const proposal = await builder.decompose(goal.id);
    expect(proposal).not.toBeNull();
    expect(proposal!.objective.title).toBe('Ship MVP');
  });

  test('decompose returns null for non-existent goal', async () => {
    const proposal = await builder.decompose('nonexistent');
    expect(proposal).toBeNull();
  });

  test('decompose returns null for daily_action (no next level)', async () => {
    const goal = vault.createGoal('Daily task', 'daily_action');
    const proposal = await builder.decompose(goal.id);
    expect(proposal).toBeNull();
  });

  test('chat returns text reply', async () => {
    const goal = vault.createGoal('Chat goal', 'objective');
    const result = await builder.chat(goal.id, 'How can I improve this?', []);

    expect(result.reply).toBeTruthy();
    expect(result.proposal).toBeUndefined();
  });
});

describe('GoalEstimator', () => {
  let estimator: GoalEstimator;

  beforeEach(() => {
    initDatabase(':memory:');
    estimator = new GoalEstimator(mockLLM);
  });

  test('quickEstimate returns heuristic for no history', () => {
    const est = estimator.quickEstimate('Build auth', 'task');
    expect(est.hours).toBe(4);
    expect(est.confidence).toBe(0.2);
  });

  test('quickEstimate uses history when available', () => {
    // Create some completed goals with actual hours
    const g1 = vault.createGoal('Build login', 'task', { status: 'active' });
    vault.updateGoalActualHours(g1.id, 6);
    vault.updateGoalStatus(g1.id, 'completed');

    const g2 = vault.createGoal('Build signup', 'task', { status: 'active' });
    vault.updateGoalActualHours(g2.id, 8);
    vault.updateGoalStatus(g2.id, 'completed');

    const est = estimator.quickEstimate('Build auth flow', 'task');
    // Should find similar goals and use their average
    expect(est.hours).toBe(7); // avg of 6 and 8
    expect(est.confidence).toBe(0.6);
  });

  test('estimate returns null for non-existent goal', async () => {
    const est = await estimator.estimate('nonexistent');
    expect(est).toBeNull();
  });

  test('estimate returns LLM-based estimate when no history', async () => {
    const goal = vault.createGoal('New feature', 'key_result', {
      description: 'Build something new',
      success_criteria: 'It works well',
    });

    const est = await estimator.estimate(goal.id);
    expect(est).not.toBeNull();
    expect(est!.llm_estimate_hours).toBe(40);
    expect(est!.historical_estimate_hours).toBeNull();
    expect(est!.final_estimate_hours).toBe(40);
    expect(est!.reasoning).toContain('No historical data');
  });

  test('estimate blends history and LLM', async () => {
    // Create completed goals with matching words
    const g1 = vault.createGoal('Build feature alpha', 'key_result', {
      status: 'active',
      description: 'Build something',
    });
    vault.updateGoalActualHours(g1.id, 30);
    vault.updateGoalStatus(g1.id, 'completed');

    const g2 = vault.createGoal('Build feature beta', 'key_result', {
      status: 'active',
      description: 'Build another thing',
    });
    vault.updateGoalActualHours(g2.id, 50);
    vault.updateGoalStatus(g2.id, 'completed');

    // Create goal to estimate
    const goal = vault.createGoal('Build feature gamma', 'key_result', {
      description: 'Build yet another thing',
      success_criteria: 'Feature complete',
    });

    const est = await estimator.estimate(goal.id);
    expect(est).not.toBeNull();
    expect(est!.historical_estimate_hours).toBe(40); // avg of 30 and 50
    expect(est!.llm_estimate_hours).toBe(40);
    // 60% history (40) + 40% LLM (40) = 40
    expect(est!.final_estimate_hours).toBe(40);
    expect(est!.confidence).toBeGreaterThan(0.5);
    expect(est!.similar_past_goals.length).toBe(2);
  });
});

import { test, expect, describe, beforeEach } from 'bun:test';
import { initDatabase } from '../vault/schema.ts';
import { DailyRhythm } from './rhythm.ts';
import { AccountabilityEngine } from './accountability.ts';
import * as vault from '../vault/goals.ts';
import type { GoalEvent } from './events.ts';

// Mock LLM manager. chatTier delegates to chat so the tier-routing migration
// is transparent to these tests.
const mockLLM: any = {
  chatTier: async (_tier: string, _sub: string, messages: any[], opts?: any) =>
    mockLLM.chat(messages, opts),
  chat: async (messages: any[], _opts?: any) => {
    const lastMsg = messages[messages.length - 1];
    const content = typeof lastMsg.content === 'string' ? lastMsg.content : '';

    if (content.includes('morning plan')) {
      return {
        content: JSON.stringify({
          focus_areas: ['Ship feature X', 'Review PR'],
          daily_actions: ['Write tests for feature X', 'Code review PR #42'],
          warnings: ['Deadline approaching for KR-1'],
          message: 'Stop procrastinating. Ship it.',
        }),
      };
    }

    if (content.includes('Review the day')) {
      return {
        content: JSON.stringify({
          score_updates: [],
          actions_completed: ['Wrote tests for feature X'],
          assessment: 'Decent day. Could have done more.',
          message: 'Not bad. Not great. Do better tomorrow.',
        }),
      };
    }

    if (content.includes('PRESSURE') || content.includes('ROOT CAUSE') || content.includes('KILL')) {
      return { content: 'You are behind. Fix it now.' };
    }

    if (content.includes('replan')) {
      return {
        content: JSON.stringify({
          options: [
            { id: 'extend', label: 'Extend deadline', description: 'Add 2 weeks', impact: 'low' },
            { id: 'kill', label: 'Kill it', description: 'Move on', impact: 'high' },
          ],
          analysis: 'The goal is too ambitious for the timeline.',
          recommendation: 'Extend the deadline.',
        }),
      };
    }

    return { content: 'OK' };
  },
};

describe('DailyRhythm', () => {
  let rhythm: DailyRhythm;
  let events: GoalEvent[];

  beforeEach(() => {
    initDatabase(':memory:');
    rhythm = new DailyRhythm(mockLLM, 'drill_sergeant');
    events = [];
    rhythm.setEventCallback((e) => events.push(e));
  });

  test('runMorningPlan creates check-in', async () => {
    vault.createGoal('Active Goal', 'task', { status: 'active' });

    const result = await rhythm.runMorningPlan();

    expect(result.checkIn.type).toBe('morning_plan');
    expect(result.focusAreas.length).toBeGreaterThan(0);
    expect(result.dailyActions.length).toBeGreaterThan(0);
    expect(result.message).toBeTruthy();

    // Event emitted
    expect(events.length).toBe(1);
    expect(events[0]!.type).toBe('check_in_morning');

    // Check-in stored in DB
    const todayCheckIn = vault.getTodayCheckIn('morning_plan');
    expect(todayCheckIn).not.toBeNull();
  });

  test('runEveningReview creates check-in', async () => {
    vault.createGoal('Active Goal', 'task', { status: 'active' });

    // Create a morning check-in first
    vault.createCheckIn('morning_plan', 'Morning focus', ['g1'], ['Write code']);

    const result = await rhythm.runEveningReview();

    expect(result.checkIn.type).toBe('evening_review');
    expect(result.assessment).toBeTruthy();
    expect(result.message).toBeTruthy();

    // Event emitted
    expect(events.length).toBe(1);
    expect(events[0]!.type).toBe('check_in_evening');
  });

  test('runMorningPlan works with no active goals', async () => {
    const result = await rhythm.runMorningPlan();
    expect(result.checkIn).toBeTruthy();
  });

  test('runEveningReview works without morning plan', async () => {
    vault.createGoal('Goal', 'task', { status: 'active' });
    const result = await rhythm.runEveningReview();
    expect(result.checkIn).toBeTruthy();
  });
});

describe('AccountabilityEngine', () => {
  let engine: AccountabilityEngine;

  beforeEach(() => {
    initDatabase(':memory:');
    engine = new AccountabilityEngine(mockLLM, 'drill_sergeant', {
      pressure: 1,
      root_cause: 3,
      suggest_kill: 4,
    });
  });

  test('runEscalationCheck returns empty for healthy goals', () => {
    vault.createGoal('Healthy', 'task', { status: 'active' });
    const actions = engine.runEscalationCheck();
    expect(actions.length).toBe(0);
  });

  test('runEscalationCheck detects goals needing escalation', () => {
    const goal = vault.createGoal('Behind Goal', 'task', { status: 'active' });
    vault.updateGoalHealth(goal.id, 'behind');
    // Simulate being behind for 2 weeks
    const db = (vault as any).__test_getDb?.() ?? require('../vault/schema.ts').getDb();
    const twoWeeksAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
    db.prepare('UPDATE goals SET updated_at = ? WHERE id = ?').run(twoWeeksAgo, goal.id);

    const actions = engine.runEscalationCheck();
    expect(actions.length).toBe(1);
    expect(actions[0]!.newStage).toBe('pressure');
  });

  test('generateEscalationMessage returns text', async () => {
    const goal = vault.createGoal('Failing Goal', 'task', { status: 'active' });
    vault.updateGoalHealth(goal.id, 'behind');

    const message = await engine.generateEscalationMessage(
      vault.getGoal(goal.id)!,
      'pressure',
    );
    expect(message).toBeTruthy();
    expect(message.length).toBeGreaterThan(0);
  });

  test('generateEscalationMessage returns empty for none stage', async () => {
    const goal = vault.createGoal('OK Goal', 'task', { status: 'active' });
    const message = await engine.generateEscalationMessage(vault.getGoal(goal.id)!, 'none');
    expect(message).toBe('');
  });

  test('generateReplanOptions returns options', async () => {
    const goal = vault.createGoal('Stuck Goal', 'objective', {
      status: 'active',
      description: 'Big project',
      success_criteria: 'Ship it',
    });

    const analysis = await engine.generateReplanOptions(vault.getGoal(goal.id)!);
    expect(analysis.options.length).toBeGreaterThanOrEqual(2);
    expect(analysis.analysis).toBeTruthy();
    expect(analysis.recommendation).toBeTruthy();
  });
});

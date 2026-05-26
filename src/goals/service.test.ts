import { test, expect, describe, beforeEach } from 'bun:test';
import { initDatabase } from '../vault/schema.ts';
import { GoalService } from './service.ts';
import type { GoalEvent } from './events.ts';
import type { GoalConfig } from '../config/types.ts';

const defaultConfig: GoalConfig = {
  enabled: true,
  morning_window: { start: 7, end: 9 },
  evening_window: { start: 20, end: 22 },
  accountability_style: 'drill_sergeant',
  escalation_weeks: { pressure: 1, root_cause: 3, suggest_kill: 4 },
  auto_decompose: true,
  calendar_ownership: false,
};

describe('GoalService', () => {
  let service: GoalService;
  let events: GoalEvent[];

  beforeEach(async () => {
    initDatabase(':memory:');
    service = new GoalService(defaultConfig);
    events = [];
    service.setEventCallback((e) => events.push(e));
  });

  test('start and stop lifecycle', async () => {
    expect(service.status()).toBe('stopped');
    await service.start();
    expect(service.status()).toBe('running');
    await service.stop();
    expect(service.status()).toBe('stopped');
  });

  test('disabled config skips start', async () => {
    const disabled = new GoalService({ ...defaultConfig, enabled: false });
    await disabled.start();
    expect(disabled.status()).toBe('stopped');
  });

  test('createGoal emits goal_created event', () => {
    const goal = service.createGoal('Test Goal', 'objective');
    expect(goal.title).toBe('Test Goal');
    expect(events.length).toBe(1);
    expect(events[0]!.type).toBe('goal_created');
    expect(events[0]!.goalId).toBe(goal.id);
  });

  test('updateGoal emits goal_updated event', () => {
    const goal = service.createGoal('Original', 'task');
    events = [];

    const updated = service.updateGoal(goal.id, { title: 'Changed' });
    expect(updated!.title).toBe('Changed');
    expect(events.length).toBe(1);
    expect(events[0]!.type).toBe('goal_updated');
  });

  test('scoreGoal emits goal_scored event (and goal_health_changed when health shifts)', () => {
    const goal = service.createGoal('Scored', 'key_result');
    events = [];

    service.scoreGoal(goal.id, 0.5, 'halfway');
    // goal_scored always fires; goal_health_changed may also fire if the
    // score change shifts the computed health bucket (it does for a fresh
    // 'on_track' goal scored to 0.5 with no deadline -> 'at_risk').
    const scored = events.find(e => e.type === 'goal_scored');
    expect(scored).toBeDefined();
    expect(scored!.data.score).toBe(0.5);
  });

  test('updateStatus emits correct event type', () => {
    const goal = service.createGoal('Status test', 'task', { status: 'active' });
    events = [];

    service.updateStatus(goal.id, 'completed');
    expect(events.length).toBe(1);
    expect(events[0]!.type).toBe('goal_completed');

    const g2 = service.createGoal('Fail test', 'task', { status: 'active' });
    events = [];
    service.updateStatus(g2.id, 'failed');
    expect(events[0]!.type).toBe('goal_failed');

    const g3 = service.createGoal('Kill test', 'task', { status: 'active' });
    events = [];
    service.updateStatus(g3.id, 'killed');
    expect(events[0]!.type).toBe('goal_killed');

    const g4 = service.createGoal('Pause test', 'task', { status: 'active' });
    events = [];
    service.updateStatus(g4.id, 'paused');
    expect(events[0]!.type).toBe('goal_status_changed');
  });

  test('updateHealth emits goal_health_changed event', () => {
    const goal = service.createGoal('Health test', 'objective');
    events = [];

    service.updateHealth(goal.id, 'at_risk');
    expect(events.length).toBe(1);
    expect(events[0]!.type).toBe('goal_health_changed');
    expect(events[0]!.data.health).toBe('at_risk');
  });

  test('deleteGoal emits goal_deleted event', () => {
    const goal = service.createGoal('Delete me', 'task');
    events = [];

    service.deleteGoal(goal.id);
    expect(events.length).toBe(1);
    expect(events[0]!.type).toBe('goal_deleted');
    expect(events[0]!.goalId).toBe(goal.id);
  });

  test('getGoal returns null for non-existent', () => {
    expect(service.getGoal('nope')).toBeNull();
  });

  test('getMetrics returns aggregated data', () => {
    service.createGoal('Active', 'task', { status: 'active' });
    service.createGoal('Draft', 'task');

    const metrics = service.getMetrics();
    expect(metrics.total).toBe(2);
    expect(metrics.active).toBe(1);
  });

  test('no events when update returns null', () => {
    events = [];
    service.updateGoal('nonexistent', { title: 'X' });
    service.scoreGoal('nonexistent', 0.5, 'nope');
    service.updateHealth('nonexistent', 'behind');
    service.deleteGoal('nonexistent');
    expect(events.length).toBe(0);
  });
});

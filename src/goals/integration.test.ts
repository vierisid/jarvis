/**
 * Tests for M16 Phase 7 — Goal System Integrations
 *
 * Tests awareness-bridge (fuzzy matching), workflow-bridge (rhythm workflows),
 * and goal context injection.
 */

import { test, expect, beforeEach } from 'bun:test';
import { initDatabase } from '../vault/schema.ts';
import { createGoal, updateGoalStatus } from '../vault/goals.ts';
import { matchAwarenessToGoals, logAutoDetectedProgress } from './awareness-bridge.ts';
import { generateRhythmWorkflows, registerGoalWorkflows } from './workflow-bridge.ts';
import { extractGoalCompletion } from '../vault/extractor.ts';
import { getActiveGoalsSummary } from '../vault/retrieval.ts';
import { findEntities } from '../vault/entities.ts';
import { findFacts } from '../vault/facts.ts';
import { DEFAULT_CONFIG, type GoalConfig } from '../config/types.ts';
import { ContextTracker } from '../awareness/context-tracker.ts';

beforeEach(() => {
  initDatabase(':memory:');
});

// ── Awareness Bridge Tests ──────────────────────────────────────────

function producerTransition(windowTitle: string) {
  const tracker = new ContextTracker(DEFAULT_CONFIG.awareness!);
  tracker.processCapture('before', '', 'Inbox - Mail');
  const event = tracker.processCapture('after', '', windowTitle).events.find(e => e.type === 'context_changed');
  expect(event).toBeDefined();
  return JSON.parse(JSON.stringify(event));
}

test('matchAwarenessToGoals returns empty when no active goals', () => {
  expect(matchAwarenessToGoals(producerTransition('index.ts - project'))).toEqual([]);
});

test('matchAwarenessToGoals finds matches for active goals', () => {
  createGoal('Learn TypeScript fundamentals', 'task', {
    description: 'Complete TypeScript tutorial covering generics, interfaces, and type guards', status: 'active',
  });
  createGoal('Exercise daily', 'daily_action', { description: 'Run or gym workout every day', status: 'active' });
  const matches = matchAwarenessToGoals(producerTransition('TypeScript Tutorial generics.ts - VS Code'));
  expect(matches.length).toBeGreaterThanOrEqual(1);
  expect(matches[0]!.goalTitle).toBe('Learn TypeScript fundamentals');
  expect(matches[0]!.matchedTerms.length).toBeGreaterThanOrEqual(2);
});

test('matchAwarenessToGoals does not match unrelated events', () => {
  createGoal('Learn Python machine learning', 'task', {
    description: 'Complete scikit-learn and tensorflow courses', status: 'active',
  });
  expect(matchAwarenessToGoals(producerTransition('Jazz Classics - Spotify'))).toEqual([]);
});

test('matchAwarenessToGoals ignores non-active goals', () => {
  createGoal('Learn TypeScript fundamentals', 'task', {
    description: 'Complete TypeScript tutorial covering generics and interfaces', status: 'completed',
  });
  expect(matchAwarenessToGoals(producerTransition('TypeScript generics tutorial - VS Code'))).toEqual([]);
});

test('logAutoDetectedProgress creates progress entries', () => {
  const goal = createGoal('Learn TypeScript', 'task', {
    description: 'Complete TypeScript tutorial',
    status: 'active',
  });

  const matches = [{
    goalId: goal.id,
    goalTitle: goal.title,
    matchScore: 0.5,
    matchedTerms: ['typescript', 'tutorial'],
    source: 'VS Code',
    eventType: 'context_changed' as const,
    observedAt: Date.now(),
  }];

  logAutoDetectedProgress(matches);

  // Check progress was logged
  const { getProgressHistory } = require('../vault/goals.ts');
  const progress = getProgressHistory(goal.id, 10);
  expect(progress.length).toBe(1);
  expect(progress[0].type).toBe('auto_detected');
  expect(progress[0].source).toBe('awareness');
  expect(progress[0].note).toContain('typescript');
});

test('logAutoDetectedProgress deduplicates within 30 minutes', () => {
  const goal = createGoal('Learn TypeScript', 'task', {
    description: 'Complete TypeScript tutorial',
    status: 'active',
  });

  const matches = [{
    goalId: goal.id,
    goalTitle: goal.title,
    matchScore: 0.5,
    matchedTerms: ['typescript', 'tutorial'],
    source: 'VS Code',
    eventType: 'context_changed' as const,
    observedAt: Date.now(),
  }];

  // First call logs progress
  logAutoDetectedProgress(matches);

  // Second call within 30min should not log again
  logAutoDetectedProgress(matches);

  const { getProgressHistory } = require('../vault/goals.ts');
  const progress = getProgressHistory(goal.id, 10);
  expect(progress.length).toBe(1); // still just 1
});

// ── Workflow Bridge Tests ───────────────────────────────────────────

test('generateRhythmWorkflows creates morning and evening workflows', () => {
  const config: GoalConfig = {
    enabled: true,
    morning_window: { start: 7, end: 9 },
    evening_window: { start: 20, end: 22 },
    accountability_style: 'drill_sergeant',
    escalation_weeks: { pressure: 1, root_cause: 3, suggest_kill: 4 },
    auto_decompose: true,
    calendar_ownership: false,
  };

  const workflows = generateRhythmWorkflows(config);
  expect(workflows.length).toBe(2);

  const morning = workflows.find(w => w.action === 'morning_plan');
  expect(morning).toBeDefined();
  expect(morning!.cronExpression).toBe('0 7 * * *');
  expect(morning!.triggerType).toBe('cron');

  const evening = workflows.find(w => w.action === 'evening_review');
  expect(evening).toBeDefined();
  expect(evening!.cronExpression).toBe('0 20 * * *');
});

test('generateRhythmWorkflows returns empty when disabled', () => {
  const config: GoalConfig = {
    enabled: false,
    morning_window: { start: 7, end: 9 },
    evening_window: { start: 20, end: 22 },
    accountability_style: 'drill_sergeant',
    escalation_weeks: { pressure: 1, root_cause: 3, suggest_kill: 4 },
    auto_decompose: true,
    calendar_ownership: false,
  };

  const workflows = generateRhythmWorkflows(config);
  expect(workflows.length).toBe(0);
});

test('generateRhythmWorkflows uses custom window times', () => {
  const config: GoalConfig = {
    enabled: true,
    morning_window: { start: 6, end: 8 },
    evening_window: { start: 21, end: 23 },
    accountability_style: 'supportive',
    escalation_weeks: { pressure: 2, root_cause: 4, suggest_kill: 6 },
    auto_decompose: true,
    calendar_ownership: true,
  };

  const workflows = generateRhythmWorkflows(config);
  const morning = workflows.find(w => w.action === 'morning_plan')!;
  const evening = workflows.find(w => w.action === 'evening_review')!;

  expect(morning.cronExpression).toBe('0 6 * * *');
  expect(evening.cronExpression).toBe('0 21 * * *');
});

test('registerGoalWorkflows logs workflows without error', () => {
  const workflows = generateRhythmWorkflows({
    enabled: true,
    morning_window: { start: 7, end: 9 },
    evening_window: { start: 20, end: 22 },
    accountability_style: 'drill_sergeant',
    escalation_weeks: { pressure: 1, root_cause: 3, suggest_kill: 4 },
    auto_decompose: true,
    calendar_ownership: false,
  });

  const mockTriggerManager = {
    fireTrigger: () => {},
  };

  // Should not throw
  expect(() => registerGoalWorkflows(workflows, mockTriggerManager)).not.toThrow();
});

// ── Phase 8: Goal Memory + Knowledge ───────────────────────────────

test('extractGoalCompletion creates entity with facts', () => {
  const goal = createGoal('Build REST API', 'milestone', {
    description: 'Create a full REST API with CRUD endpoints',
    status: 'active',
  });

  // Simulate completion
  const completedGoal = {
    ...goal,
    status: 'completed',
    score: 0.85,
    estimated_hours: 20,
    actual_hours: 25.5,
    completed_at: Date.now(),
    tags: ['backend', 'api'],
  };

  extractGoalCompletion(completedGoal);

  // Verify entity was created
  const entities = findEntities({ name: 'Build REST API', type: 'concept' });
  expect(entities.length).toBe(1);
  expect(entities[0]!.source).toBe('goal_completion');

  // Verify facts were stored
  const facts = findFacts({ subject_id: entities[0]!.id });
  const factMap = new Map(facts.map(f => [f.predicate, f.object]));

  expect(factMap.get('goal_final_score')).toBe('0.85');
  expect(factMap.get('goal_outcome')).toBe('completed');
  expect(factMap.get('goal_level')).toBe('milestone');
  expect(factMap.get('estimated_hours')).toBe('20');
  expect(factMap.get('actual_hours')).toBe('25.5');
  expect(factMap.get('goal_tags')).toBe('backend, api');
  expect(factMap.has('days_to_complete')).toBe(true);
  expect(factMap.has('estimation_accuracy')).toBe(true);
});

test('extractGoalCompletion handles failed goals', () => {
  extractGoalCompletion({
    id: 'test-failed',
    title: 'Learn Rust',
    level: 'objective',
    score: 0.2,
    status: 'failed',
    estimated_hours: null,
    actual_hours: 0,
    created_at: Date.now() - 86400000 * 30,
    completed_at: null,
    tags: [],
  });

  const entities = findEntities({ name: 'Learn Rust', type: 'concept' });
  expect(entities.length).toBe(1);

  const facts = findFacts({ subject_id: entities[0]!.id });
  const factMap = new Map(facts.map(f => [f.predicate, f.object]));
  expect(factMap.get('goal_outcome')).toBe('failed');
  expect(factMap.get('goal_final_score')).toBe('0.20');
  // No estimated_hours or actual_hours since they're null/0
  expect(factMap.has('estimated_hours')).toBe(false);
  expect(factMap.has('actual_hours')).toBe(false);
});

test('getActiveGoalsSummary returns formatted goal list', () => {
  createGoal('Get fit', 'objective', { status: 'active' });
  createGoal('Run daily', 'key_result', { status: 'active' });
  createGoal('Complete project', 'milestone', { status: 'active' });

  const summary = getActiveGoalsSummary();
  expect(summary).toContain('Get fit');
  expect(summary).toContain('Run daily');
  expect(summary).toContain('Complete project');
  expect(summary).toContain('/1.0');
});

test('getActiveGoalsSummary returns empty when no active goals', () => {
  createGoal('Done goal', 'task', { status: 'completed' });

  const summary = getActiveGoalsSummary();
  expect(summary).toBe('');
});

test('getActiveGoalsSummary sorts by level hierarchy', () => {
  createGoal('Daily run', 'daily_action', { status: 'active' });
  createGoal('Get fit', 'objective', { status: 'active' });
  createGoal('Lose 10 lbs', 'key_result', { status: 'active' });

  const summary = getActiveGoalsSummary();
  const lines = summary.split('\n');

  // Objective should come before key_result, which should come before daily_action
  const fitIndex = lines.findIndex(l => l.includes('Get fit'));
  const loseIndex = lines.findIndex(l => l.includes('Lose 10 lbs'));
  const runIndex = lines.findIndex(l => l.includes('Daily run'));

  expect(fitIndex).toBeLessThan(loseIndex);
  expect(loseIndex).toBeLessThan(runIndex);
});

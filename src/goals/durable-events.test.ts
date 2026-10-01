import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, getDb, initDatabase } from '../vault/schema.ts';
import * as vault from '../vault/goals.ts';
import { getGoalApplication } from './application-service.ts';
import { GOAL_EVENT_RETENTION_MS, GoalEventDelivery, readGoalEvents } from './event-delivery.ts';
import { findEntities } from '../vault/entities.ts';
import { GoalService } from './service.ts';
import { DailyRhythm } from './rhythm.ts';
import { getGoalReviewRecord } from './review-evidence.ts';
import { checkWorkResult, createWorkItem, decideWorkItem, getWorkItem } from './work-items.ts';
import type { GoalEvent } from './events.ts';

let directory: string;
let path: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'jarvis-goal-events-'));
  path = join(directory, 'vault.db');
  initDatabase(path, { quiet: true });
});
afterEach(() => { getGoalApplication().stopDelivery(); closeDb(); rmSync(directory, { recursive: true, force: true }); });
function restart() { getGoalApplication().stopDelivery(); closeDb(); initDatabase(path, { quiet: true }); }
function completionEntities(id: string) {
  return getDb().query("SELECT * FROM entities WHERE json_extract(properties, '$.goal_id') = ?").all(id);
}
function failMemory() {
  getDb().run(`CREATE TRIGGER fail_memory BEFORE INSERT ON facts WHEN NEW.source = 'goal_completion'
    BEGIN SELECT RAISE(ABORT, 'synthetic memory failure'); END`);
}
function acceptedWork(id: string) {
  const work = createWorkItem({ title: 'Checked delivery', goalId: id });
  decideWorkItem(work.id, { outcome: 'accepted', reason: 'Owner approved' });
  return work;
}
const checked = { verdict: 'passed', summary: 'Owner checked the delivered report', goalScore: 0.5,
  evidence: [{ ref: 'report://42', description: 'Checked totals' }] };

test('event persistence failure rolls back score, health and progress', () => {
  const goal = vault.createGoal('Atomic score', 'task');
  const before = vault.getGoal(goal.id);
  getDb().run(`CREATE TRIGGER fail_event BEFORE INSERT ON goal_events
    BEGIN SELECT RAISE(ABORT, 'synthetic event failure'); END`);
  expect(() => getGoalApplication().scoreGoal(goal.id, 0.5, 'assessment')).toThrow('synthetic event failure');
  expect(vault.getGoal(goal.id)).toEqual(before);
  expect(vault.getProgressHistory(goal.id)).toEqual([]);
  expect(readGoalEvents()).toEqual([]);
});

test('failed completion projection recovers after restart from a deleted goal snapshot', async () => {
  const goal = vault.createGoal('Original completed goal', 'task', { status: 'active' });
  vault.updateGoalScore(goal.id, 0.8, 'Owner assessment');
  failMemory();
  getGoalApplication().updateStatus(goal.id, 'completed');
  expect(vault.getGoal(goal.id)?.status).toBe('completed');
  expect(completionEntities(goal.id)).toEqual([]); // partial entity creation rolled back with facts
  expect(readGoalEvents()[0]?.completionMemory).toBe('pending');
  const eventId = readGoalEvents()[0]!.eventId;
  getGoalApplication().deleteGoal(goal.id);
  getDb().run('DROP TRIGGER fail_memory');
  restart();
  const delivered: GoalEvent[] = [];
  const service = new GoalService({ enabled: false } as any);
  service.setEventCallback(event => { delivered.push(event); });
  await service.start(); // disabled rhythms still recover durable delivery
  service.flushEvents();
  expect(delivered.map(event => event.type)).toEqual(['goal_completed', 'goal_deleted']);
  expect(delivered[0]?.eventId).toBe(eventId);
  expect(vault.getGoal(goal.id)).toBeNull();
  expect(completionEntities(goal.id)).toHaveLength(1);
  expect(readGoalEvents()[0]?.completionMemory).toBe('recorded');
  expect(getDb().query("SELECT predicate, object FROM facts WHERE source = 'goal_completion'").all()).toEqual(expect.arrayContaining([
    { predicate: 'goal_final_score', object: '0.80' }, { predicate: 'goal_outcome', object: 'completed' },
  ]));
  await service.stop();
});

test('failed broadcast cannot fail a committed mutation or suppress completion memory', () => {
  const goal = vault.createGoal('Completed', 'task');
  getGoalApplication().setEventCallback(() => { throw new Error('synthetic broadcast failure'); });
  expect(() => getGoalApplication().updateStatus(goal.id, 'completed')).not.toThrow();
  expect(completionEntities(goal.id)).toHaveLength(1);
  const eventId = readGoalEvents()[0]!.eventId;
  restart();
  const delivered: GoalEvent[] = [];
  getGoalApplication().setEventCallback(event => { delivered.push(event); });
  getGoalApplication().flushEvents();
  getGoalApplication().flushEvents();
  expect(delivered.map(event => event.eventId)).toEqual([eventId]);
  expect(completionEntities(goal.id)).toHaveLength(1);
});

test('lost broadcast acknowledgement replays the same identity without duplicating memory', () => {
  const goal = vault.createGoal('Completed', 'task');
  getDb().run(`CREATE TRIGGER fail_ack BEFORE UPDATE OF broadcast_delivered_at ON goal_events
    BEGIN SELECT RAISE(ABORT, 'synthetic acknowledgement failure'); END`);
  const delivered: GoalEvent[] = [];
  getGoalApplication().setEventCallback(event => { delivered.push(event); });
  getGoalApplication().updateStatus(goal.id, 'completed');
  expect(delivered).toHaveLength(1);
  getDb().run('DROP TRIGGER fail_ack');
  restart();
  getGoalApplication().setEventCallback(event => { delivered.push(event); });
  getGoalApplication().flushEvents();
  expect(delivered).toHaveLength(2);
  expect(delivered[0]!.eventId).toBe(delivered[1]!.eventId);
  expect(completionEntities(goal.id)).toHaveLength(1);
});

test('reopening clears completion time and a new completion preserves a separate outcome', () => {
  const goal = vault.createGoal('Reopened', 'task');
  getGoalApplication().updateStatus(goal.id, 'failed');
  getGoalApplication().updateStatus(goal.id, 'active');
  expect(vault.getGoal(goal.id)?.completed_at).toBeNull();
  getGoalApplication().scoreGoal(goal.id, 0.9, 'Owner assessment');
  getGoalApplication().updateStatus(goal.id, 'completed');
  expect(completionEntities(goal.id)).toHaveLength(2);
  expect(getDb().query("SELECT object FROM facts WHERE predicate = 'goal_outcome'").all()).toEqual(expect.arrayContaining([{ object: 'failed' }, { object: 'completed' }]));
});

test('Today result, progress, health and events commit together and are visible to the callback', () => {
  const goal = vault.createGoal('Checked report', 'task', { status: 'active' });
  const work = acceptedWork(goal.id);
  const events: GoalEvent[] = [];
  getGoalApplication().setEventCallback(event => {
    expect(getWorkItem(work.id).resultCheck?.goalProgressId).toBeDefined();
    expect(getWorkItem(work.id).status).toBe('verified');
    events.push(event);
  });
  const saved = checkWorkResult(work.id, checked);
  expect(vault.getGoal(goal.id)).toMatchObject({ score: 0.5, health: 'at_risk' });
  expect(events.map(event => event.type)).toEqual(['goal_scored', 'goal_health_changed']);
  expect(events[0]?.data.progressId).toBe(saved.resultCheck?.goalProgressId);
  expect(() => checkWorkResult(work.id, checked)).toThrow('already checked');
  expect(vault.getProgressHistory(goal.id)).toHaveLength(1);
});

test('a late Today write failure leaves no score, progress or event', () => {
  const goal = vault.createGoal('Checked report', 'task', { status: 'active' });
  const work = acceptedWork(goal.id);
  const before = vault.getGoal(goal.id);
  getDb().run(`CREATE TRIGGER fail_result BEFORE UPDATE OF result_check ON commitment_work
    BEGIN SELECT RAISE(ABORT, 'synthetic result failure'); END`);
  const delivered: GoalEvent[] = [];
  getGoalApplication().setEventCallback(event => { delivered.push(event); });
  expect(() => checkWorkResult(work.id, checked)).toThrow('synthetic result failure');
  expect(vault.getGoal(goal.id)).toEqual(before);
  expect(vault.getProgressHistory(goal.id)).toEqual([]);
  expect(getWorkItem(work.id).resultCheck).toBeNull();
  expect(readGoalEvents()).toEqual([]);
  expect(delivered).toEqual([]);
});

test('C4 evening evidence and its event commit together despite delivery failure, without an automatic score', async () => {
  const goal = vault.createGoal('Reviewed', 'task', { status: 'active' });
  getGoalApplication().recordActivity(goal.id, 'Observed editor activity; no verified outcome', Date.now());
  getGoalApplication().setEventCallback(() => { throw new Error('offline'); });
  const rhythm = new DailyRhythm({ chatTier: async () => ({ content: JSON.stringify({
    assessment: 'Activity is not measured progress', score_updates: [{ goalId: goal.id, newScore: 0.9, reason: 'Worked' }],
  }) }) });
  const review = await rhythm.runEveningReview();
  expect(review.scoreUpdates).toEqual([]);
  expect(vault.getGoal(goal.id)?.score).toBe(0);
  expect(vault.getProgressHistory(goal.id)).toHaveLength(1);
  expect(vault.getRecentCheckIns('evening_review', 10)).toHaveLength(1);
  restart();
  expect(getGoalReviewRecord(review.checkIn.id)?.rejectedScoreUpdates).toHaveLength(1);
  const delivered: GoalEvent[] = [];
  getGoalApplication().setEventCallback(event => { delivered.push(event); });
  getGoalApplication().flushEvents();
  expect(delivered.map(event => event.type)).toEqual(['goal_activity_recorded', 'check_in_evening']);
  expect(delivered[1]?.data.checkInId).toBe(review.checkIn.id);
});

test('C5 proposal failure rolls back parent, children and their events', () => {
  getDb().run(`CREATE TRIGGER fail_child BEFORE INSERT ON goals WHEN NEW.level = 'key_result'
    BEGIN SELECT RAISE(ABORT, 'synthetic child failure'); END`);
  const proposal = { objective: { title: 'Parent', description: '', success_criteria: 'Delivered', time_horizon: 'quarterly' },
    key_results: [{ title: 'Child', description: '', success_criteria: 'Verified' }], milestones: [] };
  expect(() => getGoalApplication().createFromProposal(proposal)).toThrow('synthetic child failure');
  expect(vault.findGoals()).toEqual([]);
  expect(readGoalEvents()).toEqual([]);
});


function completionFacts(goalId: string) {
  return getDb().query<{ id: string; predicate: string; object: string }, [string]>(`
    SELECT f.id, f.predicate, f.object FROM facts f JOIN entities e ON e.id = f.subject_id
    WHERE json_extract(e.properties, '$.goal_id') = ? ORDER BY f.id
  `).all(goalId);
}
const fullTag = (index: number) => `tag-${index}-`.padEnd(512, 'x');
const maximumTags = () => Array.from({ length: 100 }, (_, index) => fullTag(index));
const tagCases = [
  { label: 'exactly 4000 joined characters', tags: [...Array.from({ length: 7 }, (_, i) => fullTag(i)), 'tail'.padEnd(402, 'x')], compact: true },
  { label: '4001 joined characters', tags: [...Array.from({ length: 7 }, (_, i) => fullTag(i)), 'tail'.padEnd(403, 'x')], compact: false },
  { label: '100 tags of 512 characters', tags: maximumTags(), compact: false },
];
for (const { label, tags, compact } of tagCases) {
  test(`completion tags preserve accepted data at ${label}`, () => {
    const goal = getGoalApplication().createGoal('Tagged completion', 'task', { tags, status: 'active' });
    getGoalApplication().scoreGoal(goal.id, 0.8, 'Owner assessment');
    getGoalApplication().updateStatus(goal.id, 'completed');
    expect(readGoalEvents().find(event => event.type === 'goal_completed')?.completionMemory).toBe('recorded');
    expect(completionEntities(goal.id)).toHaveLength(1);
    const facts = completionFacts(goal.id);
    expect(facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ predicate: 'goal_outcome', object: 'completed' }),
      expect.objectContaining({ predicate: 'goal_final_score', object: '0.80' }),
    ]));
    expect(facts.every(fact => fact.object.length <= 4000)).toBe(true);
    if (compact) {
      expect(facts.filter(fact => fact.predicate === 'goal_tags').map(fact => fact.object)).toEqual([tags.join(', ')]);
    } else {
      expect(facts.filter(fact => fact.predicate === 'goal_tag').map(fact => fact.object).sort()).toEqual([...tags].sort());
    }
    expect(vault.getGoal(goal.id)?.tags).toEqual(tags);
  });
}

test('completion tags recover the full original snapshot after restart without duplicate facts', async () => {
  const tags = maximumTags();
  const goal = getGoalApplication().createGoal('Recover tagged completion', 'task', { tags, status: 'active' });
  failMemory();
  getGoalApplication().updateStatus(goal.id, 'completed');
  const pending = readGoalEvents().find(event => event.type === 'goal_completed')!;
  expect(pending.completionMemory).toBe('pending');
  expect(completionEntities(goal.id)).toEqual([]);
  // Recovery must use the durable completion snapshot, not the goal's latest tags.
  getGoalApplication().updateGoal(goal.id, { tags: ['edited after completion'] });
  getDb().run('DROP TRIGGER fail_memory');
  restart();
  const service = new GoalService({ enabled: false } as any);
  await service.start();
  expect(readGoalEvents().find(event => event.eventId === pending.eventId)?.completionMemory).toBe('recorded');
  expect(completionEntities(goal.id)).toHaveLength(1);
  const facts = completionFacts(goal.id);
  expect(facts.filter(fact => fact.predicate === 'goal_tag').map(fact => fact.object).sort()).toEqual([...tags].sort());
  expect(facts.some(fact => fact.predicate === 'goal_outcome' && fact.object === 'completed')).toBe(true);
  expect(vault.getGoal(goal.id)?.tags).toEqual(['edited after completion']);
  service.flushEvents();
  await service.stop();
  restart();
  getGoalApplication().flushEvents();
  expect(completionFacts(goal.id)).toEqual(facts);
  expect(completionEntities(goal.id)).toHaveLength(1);
});

function attempts(eventId: string) {
  return (getDb().query('SELECT attempts FROM goal_events WHERE event_id = ?').get(eventId) as { attempts: number }).attempts;
}

test('a failing completion record is retried by the worker, not by every later goal write', () => {
  const goal = vault.createGoal('Poison completion', 'task', { status: 'active' });
  failMemory();
  getGoalApplication().updateStatus(goal.id, 'completed');
  const pending = readGoalEvents().find(event => event.type === 'goal_completed')!;
  expect(attempts(pending.eventId!)).toBe(1);
  getGoalApplication().createGoal('Later write', 'task');
  getGoalApplication().scoreGoal(goal.id, 0.4, 'Later score');
  expect(attempts(pending.eventId!)).toBe(1);
  getGoalApplication().flushEvents();
  expect(attempts(pending.eventId!)).toBe(2);
  getDb().run('DROP TRIGGER fail_memory');
  getGoalApplication().flushEvents();
  expect(readGoalEvents().find(event => event.eventId === pending.eventId)?.completionMemory).toBe('recorded');
  expect(completionEntities(goal.id)).toHaveLength(1);
});

test('retention prunes only fully delivered history and never reuses a sequence', () => {
  failMemory();
  const app = getGoalApplication();
  const [old, unbroadcast, recent] = ['Old delivered', 'Old pending broadcast', 'Recent delivered'].map(title => app.createGoal(title, 'task'));
  app.createGoal('Old pending memory', 'task', { status: 'completed' });
  const before = readGoalEvents();
  expect(before.at(-1)?.completionMemory).toBe('pending');
  const now = Date.now();
  getDb().run('UPDATE goal_events SET created_at = ?, broadcast_delivered_at = ?', [now - GOAL_EVENT_RETENTION_MS - 1, now]);
  getDb().run("UPDATE goal_events SET broadcast_delivered_at = NULL WHERE json_extract(event, '$.goalId') = ?", [unbroadcast!.id]);
  getDb().run("UPDATE goal_events SET created_at = ? WHERE json_extract(event, '$.goalId') = ?", [now, recent!.id]);
  const delivery = new GoalEventDelivery(getDb());
  expect(delivery.prune(now)).toBe(1);
  expect(readGoalEvents().map(event => event.goalId)).toEqual(before.filter(event => event.goalId !== old!.id).map(event => event.goalId));
  expect(delivery.prune(now)).toBe(0);
  getDb().run('DROP TRIGGER fail_memory');
  app.createGoal('After prune', 'task');
  expect(readGoalEvents().at(-1)!.sequence).toBeGreaterThan(before.at(-1)!.sequence!);
});

test('completion records never shadow the goal name for conversation memory', () => {
  const goal = vault.createGoal('Learn Spanish', 'task', { status: 'active' });
  getGoalApplication().updateStatus(goal.id, 'completed');
  expect(findEntities({ name: 'Learn Spanish' })).toEqual([]);
  expect(findEntities({ source: 'goal_completion' })).toEqual([
    expect.objectContaining({ name: 'Goal completed: Learn Spanish', type: 'event' }),
  ]);
});

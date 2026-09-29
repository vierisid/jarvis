import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeAwarenessActivityEvent } from '../awareness/activity-events.ts';
import { ContextTracker } from '../awareness/context-tracker.ts';
import type { AwarenessConfig } from '../config/types.ts';
import { closeDb, getDb, initDatabase } from '../vault/schema.ts';
import * as vault from '../vault/goals.ts';
import { recordGoalAwarenessActivity } from './awareness-bridge.ts';
import { buildGoalReviewBundle, validateReviewScores } from './review-evidence.ts';

const config: AwarenessConfig = {
  enabled: true, capture_interval_ms: 15000, min_change_threshold: 0.02,
  cloud_vision_enabled: false, cloud_vision_cooldown_ms: 30000,
  cloud_vision_ambient_cooldown_ms: 900000, stuck_threshold_ms: 300000,
  suggestion_rate_limit_ms: 60000, retention: { full_hours: 24, key_moment_hours: 72 },
  struggle_grace_ms: 120000, struggle_cooldown_ms: 180000, overlay_autolaunch: false,
};
let directory: string | undefined;
beforeEach(() => initDatabase(':memory:', { quiet: true }));
afterEach(() => {
  closeDb();
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

function goal(title = 'Phoenix deployment', status: 'active' | 'completed' = 'active') {
  return vault.createGoal(title, 'key_result', { status,
    description: 'Ship the customer release', success_criteria: 'Customer confirms production delivery' });
}

// The tracker is the producer. Round-trip its envelope rather than inventing
// the bridge's own fixture fields. C1 separately fixes capture ingress ordering.
function transition(from = 'Inbox - Mail', to = 'Phoenix deployment - Editor') {
  const tracker = new ContextTracker(config);
  const time = Date.now() - 1000;
  tracker.processCapture('before', 'screen text', from, time);
  const event = tracker.processCapture('after', 'screen text', to, time + 100).events
    .find(event => event.type === 'context_changed');
  expect(event).toBeDefined();
  return JSON.parse(JSON.stringify(event));
}
function deliver(event: ReturnType<typeof transition>) {
  return recordGoalAwarenessActivity(event);
}
const activity = (id: string) => vault.getProgressHistory(id).filter(p => p.type === 'auto_detected');

test('serialized producer transition adds one attributed activity note without changing the goal', () => {
  const target = goal();
  vault.updateGoalScore(target.id, 0.35, 'Confirmed earlier', 'user');
  const before = vault.getGoal(target.id)!;
  const event = transition();
  expect(deliver(event).map(match => match.goalId)).toEqual([target.id]);
  deliver(JSON.parse(JSON.stringify(event)));
  const notes = activity(target.id);
  expect(notes).toHaveLength(1);
  expect(notes[0]).toMatchObject({ goal_id: target.id, source: 'awareness',
    score_before: 0.35, score_after: 0.35 });
  expect(notes[0]!.note).toContain('Editor');
  expect(vault.getGoal(target.id)).toEqual(before);
  const bundle = buildGoalReviewBundle([before], null);
  expect(bundle.goals[0]!.activity.map(note => note.id)).toContain(`goal_progress:${notes[0]!.id}`);
  expect(bundle.goals[0]!.verifiedOutcomes).toEqual([]);
  expect(validateReviewScores(bundle, [{ goalId: target.id, newScore: 0.9,
    reason: 'Activity is not an outcome', evidenceIds: [`goal_progress:${notes[0]!.id}`] }]).rejectedScoreUpdates)
    .toContainEqual({ goalId: target.id, reason: 'activity_or_score_history_only' });
});

test('destination matches without attributing the departed window to current work', () => {
  const target = goal();
  const departed = goal('Quarterly finance');
  expect(deliver(transition('Quarterly finance - Sheets')).map(m => m.goalId)).toEqual([target.id]);
  expect(activity(departed.id)).toEqual([]);
});

test('real title-only transition can attach to an active goal', () => {
  const target = goal();
  expect(deliver(transition('Inbox - Editor')).map(m => m.goalId)).toEqual([target.id]);
});

test('inactive and unrelated goals receive no note', () => {
  const inactive = goal('Phoenix deployment', 'completed');
  const unrelated = goal('Marathon training');
  expect(deliver(transition())).toEqual([]);
  expect(activity(inactive.id)).toEqual([]);
  expect(activity(unrelated.id)).toEqual([]);
});

test('duplicate detection is not displaced by five newer manual notes', () => {
  const target = goal();
  const event = transition();
  deliver(event);
  for (let i = 0; i < 6; i++) {
    const entry = vault.addProgressEntry(target.id, 'manual', 0, 0, 'Unrelated note', 'user');
    getDb().prepare('UPDATE goal_progress SET created_at = ? WHERE id = ?').run(Date.now() + i + 1, entry.id);
  }
  deliver(event);
  expect(activity(target.id)).toHaveLength(1);
});


test('producer and consumer share v1, with compatibility for unversioned producer envelopes', () => {
  const target = goal();
  const event = transition();
  expect(event.schemaVersion).toBe(1);
  expect(normalizeAwarenessActivityEvent(event)).toEqual(event);
  delete event.schemaVersion;
  expect(normalizeAwarenessActivityEvent(event)?.schemaVersion).toBe(1);
  expect(deliver(event).map(match => match.goalId)).toEqual([target.id]);
});

const invalidEvents: [string, (event: any) => unknown][] = [
  ['unknown version', event => ({ ...event, schemaVersion: 2 })],
  ['string version', event => ({ ...event, schemaVersion: '1' })],
  ['null version', event => ({ ...event, schemaVersion: null })],
  ['missing destination', event => ({ ...event, data: { fromApp: 'Mail', fromWindow: 'Inbox' } })],
  ['object text', event => ({ ...event, data: { ...event.data, toWindow: { title: 'Phoenix deployment' } } })],
  ['missing timestamp', event => ({ ...event, timestamp: undefined })],
  ['invalid timestamp', event => ({ ...event, timestamp: NaN })],
  ['negative timestamp', event => ({ ...event, timestamp: -1 })],
  ['unrelated event', event => ({ ...event, type: 'suggestion_ready' })],
  ['invented legacy fields', event => ({ ...event, data: { app_name: 'Editor', window_title: 'Phoenix deployment' } })],
  ['bare data', event => event.data],
  ['array envelope', event => [event]],
  ['null envelope', () => null],
];
test.each(invalidEvents)('rejects %s without writing activity', (_name, invalid) => {
  const target = goal();
  expect(deliver(invalid(transition()))).toEqual([]);
  expect(activity(target.id)).toEqual([]);
});

test('ignores unrelated extra text even when it repeats goal keywords', () => {
  const target = goal();
  const event = transition('Phoenix deployment - Editor', 'Music - Player');
  event.data.ocr_text = event.data.summary = event.data.body = 'Phoenix deployment';
  expect(deliver(event)).toEqual([]);
  expect(activity(target.id)).toEqual([]);
});

test('session activity uses its actual apps, not invented summary fields', () => {
  const target = goal('Learn Visual Studio Code');
  const unrelated = goal('Phoenix deployment');
  const event = { schemaVersion: 1, type: 'session_ended', timestamp: Date.now(),
    data: { sessionId: 'observed-session', apps: ['Visual Studio Code'], summary: 'Phoenix deployment' } };
  expect(deliver(event).map(match => match.goalId)).toEqual([target.id]);
  expect(activity(target.id)[0]!.note).toContain('Visual Studio Code');
  expect(activity(unrelated.id)).toEqual([]);
});

test.each([null, '', '   '])('an ended session without identity %p is not attributed', sessionId => {
  const target = goal('Learn Visual Studio Code');
  expect(deliver({ schemaVersion: 1, type: 'session_ended', timestamp: Date.now(),
    data: { sessionId, apps: ['Visual Studio Code'] } })).toEqual([]);
  expect(activity(target.id)).toEqual([]);
});

test.each([null, 'Visual Studio Code', [{}], ['Visual Studio Code', 42]])('malformed session apps %p are rejected', apps => {
  const target = goal('Learn Visual Studio Code');
  expect(deliver({ schemaVersion: 1, type: 'session_ended', timestamp: Date.now(),
    data: { sessionId: 'session', apps } })).toEqual([]);
  expect(activity(target.id)).toEqual([]);
});

test('activity throttling survives database reopen and expires after thirty minutes', () => {
  closeDb();
  directory = mkdtempSync(join(tmpdir(), 'jarvis-c2-'));
  const dbPath = join(directory, 'goals.db');
  initDatabase(dbPath, { quiet: true });
  const target = goal();
  const event = transition();
  deliver(event);
  closeDb();
  initDatabase(dbPath, { quiet: true });
  deliver(event);
  expect(activity(target.id)).toHaveLength(1);
  const first = activity(target.id)[0]!;
  getDb().prepare('UPDATE goal_progress SET created_at = ? WHERE id = ?')
    .run(Date.now() - 31 * 60 * 1000, first.id);
  deliver(transition('Inbox - Mail', 'Phoenix deployment checklist - Editor'));
  expect(activity(target.id)).toHaveLength(2);
});

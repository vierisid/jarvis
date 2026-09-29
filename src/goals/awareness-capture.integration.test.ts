import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { AwarenessEvent } from '../awareness/types.ts';
import { AwarenessService } from '../awareness/service.ts';
import { DEFAULT_CONFIG } from '../config/types.ts';
import { closeDb, initDatabase } from '../vault/schema.ts';
import * as vault from '../vault/goals.ts';
import { recordGoalAwarenessActivity } from './awareness-bridge.ts';
import { buildGoalReviewBundle } from './review-evidence.ts';

let service: AwarenessService;
let events: AwarenessEvent[];
const config = { ...DEFAULT_CONFIG, awareness: { ...DEFAULT_CONFIG.awareness!, cloud_vision_enabled: false,
  overlay_autolaunch: false, enabled: true } };
beforeEach(async () => {
  initDatabase(':memory:', { quiet: true });
  events = [];
  service = new AwarenessService(config, {} as never, event => {
    const serialized: AwarenessEvent = JSON.parse(JSON.stringify(event));
    events.push(serialized);
    recordGoalAwarenessActivity(serialized);
  });
  await service.start();
});
afterEach(async () => { await service.stop(); closeDb(); });
const send = (type: string, timestamp: number, payload: unknown) => service.handleSidecarEvent('desktop',
  JSON.parse(JSON.stringify({ type: 'sidecar_event', event_type: type, timestamp, priority: 'normal', payload })));
const capture = (id: number, timestamp: number, app: string, title: string) => send('screen_capture', timestamp,
  { capture_id: id, image_path: `/fixture/${id}.png`, pixel_change_pct: 0.4, ocr_text: 'screen', app_name: app, window_title: title });

test.each(['before', 'after'])('native captures and explicit hint %s produce one correct note', async order => {
  const target = vault.createGoal('Phoenix deployment', 'key_result', { status: 'active' });
  const departed = vault.createGoal('Quarterly finance', 'task', { status: 'active' });
  vault.updateGoalScore(target.id, 0.4, 'Confirmed previously');
  const original = vault.getGoal(target.id)!;
  const time = Date.now() - 1000;
  await capture(1, time, 'Editor', 'Quarterly finance');
  const hint = () => send('context_changed', time + 100, { from_app: 'Editor', from_window: 'Quarterly finance',
    to_app: 'Browser', to_window: 'Phoenix deployment' });
  if (order === 'before') await hint();
  await capture(2, time + 200, 'Browser', 'Phoenix deployment');
  if (order === 'after') await hint();
  await capture(3, time + 300, 'Browser', 'Phoenix deployment');
  const contextEvents = events.filter(event => event.type === 'context_changed');
  expect(contextEvents).toHaveLength(1);
  expect(contextEvents[0]!.schemaVersion).toBe(1);
  recordGoalAwarenessActivity(contextEvents[0]);
  const notes = vault.getProgressHistory(target.id).filter(note => note.type === 'auto_detected');
  expect(notes).toHaveLength(1);
  expect(notes[0]).toMatchObject({ goal_id: target.id, source: 'awareness', score_before: 0.4, score_after: 0.4 });
  expect(notes[0]!.note).toContain('Browser');
  expect(vault.getProgressHistory(departed.id)).toHaveLength(0);
  expect(vault.getGoal(target.id)).toEqual(original);
  expect(buildGoalReviewBundle([original], null).goals[0]!.verifiedOutcomes).toEqual([]);
});

test('a real ended session matches its apps and does not invent a summary', async () => {
  const target = vault.createGoal('Learn Visual Studio Code', 'task', { status: 'active' });
  const time = Date.now() - 1000;
  await capture(1, time, 'Visual Studio Code', 'Untitled');
  await capture(2, time + 200, 'Browser', 'Inbox');
  const ended = events.find(event => event.type === 'session_ended');
  expect(ended?.data.sessionId).toBeTruthy();
  expect(ended?.schemaVersion).toBe(1);
  const notes = vault.getProgressHistory(target.id);
  expect(notes).toHaveLength(1);
  expect(notes[0]!.note).toContain('session_ended via Visual Studio Code');
  expect(vault.getGoal(target.id)!.score).toBe(0);
});

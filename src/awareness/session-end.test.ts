import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { ContextTracker } from './context-tracker.ts';
import { AwarenessService } from './service.ts';
import { AwarenessIntelligence } from './intelligence.ts';
import { SuggestionEngine } from './suggestion-engine.ts';
import { closeDb, initDatabase } from '../vault/schema.ts';
import { getSession } from '../vault/awareness.ts';
import type { AwarenessConfig, JarvisConfig } from '../config/types.ts';
import type { AwarenessEvent } from './types.ts';
import type { LLMManager } from '../llm/manager.ts';
import type { SidecarEvent } from '../sidecar/protocol.ts';

const config: AwarenessConfig = {
  enabled: true, capture_interval_ms: 15000, min_change_threshold: 0.02,
  cloud_vision_enabled: false, cloud_vision_cooldown_ms: 30000,
  cloud_vision_ambient_cooldown_ms: 900000, stuck_threshold_ms: 300000,
  suggestion_rate_limit_ms: 60000, retention: { full_hours: 24, key_moment_hours: 72 },
  struggle_grace_ms: 120000, struggle_cooldown_ms: 180000, overlay_autolaunch: false,
};
const services: AwarenessService[] = [];
let summary: ReturnType<typeof spyOn>;
let suggestions: ReturnType<typeof spyOn>;
beforeEach(() => {
  initDatabase(':memory:', { quiet: true });
  summary = spyOn(AwarenessIntelligence.prototype, 'summarizeSession').mockResolvedValue({ topic: 'Draft review', summary: 'Reviewed the draft.' });
  suggestions = spyOn(SuggestionEngine.prototype, 'evaluate').mockResolvedValue(null);
});
afterEach(async () => {
  for (const service of services.splice(0)) await service.stop();
  summary.mockRestore(); suggestions.mockRestore(); closeDb();
});
async function service(callback: (event: AwarenessEvent) => void) {
  const value = new AwarenessService({ awareness: config } as JarvisConfig, {} as LLMManager, callback);
  services.push(value); await value.start(); return value;
}
function send(value: AwarenessService, event_type: string, timestamp: number, payload: Record<string, unknown>) {
  const event: SidecarEvent = JSON.parse(JSON.stringify({ type: 'sidecar_event', event_type, timestamp, priority: 'normal', payload }));
  return value.handleSidecarEvent('desktop', event);
}
function capture(value: AwarenessService, timestamp: number, app = 'Editor') {
  return send(value, 'screen_capture', timestamp, { capture_id: timestamp, image_path: '/fixture/screen.png',
    pixel_change_pct: 0.5, ocr_text: 'Reviewing the project draft and its delivery notes.', app_name: app, window_title: `Draft - ${app}` });
}
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

test('app-switch end snapshots are deeply immutable and independent of the new session', () => {
  const tracker = new ContextTracker(config);
  const start = Date.now() - 180000;
  const first = tracker.processCapture('one', 'draft', 'Draft - Editor', start);
  const changed = tracker.processCapture('two', 'inbox', 'Inbox - Browser', start + 120000);
  const ended = changed.events.find(event => event.type === 'session_ended')!;
  expect(ended).toEqual({ type: 'session_ended', schemaVersion: 1, timestamp: start + 120000,
    data: { sessionId: first.context.sessionId, apps: ['Editor'] } });
  expect(Object.isFrozen(ended)).toBe(true);
  expect(Object.isFrozen(ended.data)).toBe(true);
  expect(Object.isFrozen(ended.data.apps)).toBe(true);
  expect(getSession(first.context.sessionId)!.ended_at).toBe(ended.timestamp);
  tracker.endCurrentSession();
  expect(ended.data).toEqual({ sessionId: first.context.sessionId, apps: ['Editor'] });
});

test('a delayed app switch cannot end a session before it started', () => {
  const tracker = new ContextTracker(config);
  const start = Date.now() - 180000;
  const first = tracker.processCapture('one', 'draft', 'Draft - Editor', start);
  const delayed = tracker.processCapture('two', 'inbox', 'Inbox - Browser', start - 120000);
  const ended = delayed.events.find(event => event.type === 'session_ended')!;
  expect(ended.timestamp).toBe(start);
  expect(getSession(first.context.sessionId)!.ended_at).toBe(start);
  expect(ended.data.sessionId).toBe(first.context.sessionId);
  // The new session keeps its source time and gets its own observation bound.
  expect(delayed.context.timestamp).toBe(start - 120000);
  const nextEnd = tracker.endCurrentSession(start - 180000)!;
  expect(nextEnd.timestamp).toBe(start - 120000);
  expect(getSession(delayed.context.sessionId)!.ended_at).toBe(nextEnd.timestamp);
});

test('delayed captures do not shorten observed work or suppress its summary', async () => {
  const events: AwarenessEvent[] = [];
  const value = await service(event => events.push(event));
  const start = Date.now() - 600000;
  await capture(value, start);
  const id = value.getCurrentSession()!.id;
  await capture(value, start + 180000);
  // Both a late same-app observation and a late app switch arrive afterward.
  await capture(value, start + 60000);
  await capture(value, start - 120000, 'Browser'); await settle();
  const ends = events.filter(event => event.type === 'session_ended');
  expect(ends).toHaveLength(1);
  expect(ends[0]!.data).toEqual({ sessionId: id, apps: ['Editor'] });
  expect(ends[0]!.timestamp).toBe(start + 180000);
  expect(getSession(id)!.ended_at).toBe(ends[0]!.timestamp);
  expect(summary).toHaveBeenCalledTimes(1);
  expect(summary.mock.calls[0]!.slice(0, 3)).toEqual([['Editor'], 3, 3]);
  expect(getSession(id)!.summary).toBe('Reviewed the draft.');
});

test('shutdown cannot end a clock-skewed session before its last observation', async () => {
  const events: AwarenessEvent[] = [];
  const value = await service(event => events.push(event));
  const start = Date.now() + 3600000;
  await capture(value, start);
  const id = value.getCurrentSession()!.id;
  await capture(value, start + 180000);
  await value.stop();
  const ended = events.find(event => event.type === 'session_ended')!;
  expect(ended.timestamp).toBe(start + 180000);
  expect(getSession(id)!.ended_at).toBe(ended.timestamp);
  expect(summary).not.toHaveBeenCalled();
});

test('an idle return to the same app closes the old session exactly once', () => {
  const tracker = new ContextTracker(config);
  const start = Date.now() - 600000;
  const first = tracker.processCapture('one', 'draft', 'Draft - Editor', start);
  const returned = tracker.processCapture('two', 'draft', 'Draft - Editor', start + 360000);
  const ends = returned.events.filter(event => event.type === 'session_ended');
  expect(ends).toHaveLength(1);
  expect(ends[0]!.data).toEqual({ sessionId: first.context.sessionId, apps: ['Editor'] });
  expect(getSession(first.context.sessionId)!.ended_at).toBe(start + 360000);
  expect(returned.context.sessionId).not.toBe(first.context.sessionId);
  const duplicate = tracker.processCapture('two', 'draft', 'Draft - Editor', start + 360000);
  expect(duplicate.events.filter(event => event.type === 'session_ended')).toEqual([]);
  expect(duplicate.context.sessionId).toBe(returned.context.sessionId);
});

test('explicit close returns one stable snapshot and a repeated close returns nothing', () => {
  const tracker = new ContextTracker(config);
  const first = tracker.processCapture('one', 'draft', 'Draft - Editor');
  const ended = tracker.endCurrentSession();
  expect(ended?.data).toEqual({ sessionId: first.context.sessionId, apps: ['Editor'] });
  expect(tracker.getCurrentSession()).toBeNull();
  expect(tracker.endCurrentSession()).toBeNull();
});

test('a listener cannot change the identity or apps subsequently used by summary inference', async () => {
  const events: AwarenessEvent[] = [];
  const value = await service(event => {
    if (event.type !== 'session_ended') return;
    events.push(event);
    Reflect.set(event.data, 'sessionId', 'another-session');
    try { (event.data.apps as string[]).push('Injected app'); } catch { /* frozen snapshot */ }
  });
  const start = Date.now() - 240000;
  await capture(value, start);
  const id = value.getCurrentSession()!.id;
  await capture(value, start + 180000, 'Browser'); await settle();
  expect(events[0]!.data).toEqual({ sessionId: id, apps: ['Editor'] });
  expect(summary).toHaveBeenCalledTimes(1);
  expect(summary.mock.calls[0]![0]).toEqual(['Editor']);
  expect(getSession(id)!.summary).toBe('Reviewed the draft.');
});

test('repeated serialized idle signals and a repeated returning capture produce one summary', async () => {
  const events: AwarenessEvent[] = [];
  const value = await service(event => events.push(event));
  const start = Date.now() - 600000;
  await capture(value, start);
  const id = value.getCurrentSession()!.id;
  const idle = () => send(value, 'idle_detected', start + 350000, { duration_ms: 350000, app_name: 'Editor' });
  await idle(); await idle();
  // The sidecar signal describes an unchanged window, not an ended session.
  expect(value.getCurrentSession()!.id).toBe(id);
  await capture(value, start + 360000);
  await idle(); await idle();
  await capture(value, start + 360000); await settle();
  expect(events.filter(event => event.type === 'session_ended').map(event => event.data)).toEqual([{ sessionId: id, apps: ['Editor'] }]);
  expect(summary).toHaveBeenCalledTimes(1);
  expect(getSession(id)!.summary).toBe('Reviewed the draft.');
});

test('session-end delivery and summary do not depend on later suggestion success', async () => {
  const events: AwarenessEvent[] = [];
  const value = await service(event => events.push(event));
  const start = Date.now() - 240000;
  await capture(value, start);
  const id = value.getCurrentSession()!.id;
  suggestions.mockRejectedValueOnce(new Error('synthetic suggestion failure'));
  await capture(value, start + 180000, 'Browser'); await settle();
  expect(events.filter(event => event.type === 'session_ended').map(event => event.data.sessionId)).toEqual([id]);
  expect(getSession(id)!.summary).toBe('Reviewed the draft.');
});

test('shutdown emits one end snapshot without launching new summary work', async () => {
  const events: AwarenessEvent[] = [];
  const value = await service(event => events.push(event));
  await capture(value, Date.now() - 180000);
  const id = value.getCurrentSession()!.id;
  await value.stop(); await value.stop();
  expect(events.filter(event => event.type === 'session_ended').map(event => event.data)).toEqual([{ sessionId: id, apps: ['Editor'] }]);
  expect(summary).not.toHaveBeenCalled();
});


test('concurrent and later replays of a real ended session do not recompute its summary', async () => {
  let release!: (value: { topic: string; summary: string }) => void;
  summary.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const events: AwarenessEvent[] = [];
  const value = await service(event => events.push(event));
  const start = Date.now() - 240000;
  await capture(value, start);
  await capture(value, start + 180000, 'Browser');
  const ended = events.find(event => event.type === 'session_ended')!;
  // Replay the serialized producer payload at the existing summary-consumer seam.
  const payload = JSON.parse(JSON.stringify(ended.data));
  const consumer = value as unknown as { inferSessionTopic(data: typeof payload): Promise<void> };
  try {
    await consumer.inferSessionTopic(payload);
    expect(summary).toHaveBeenCalledTimes(1);
  } finally {
    release({ topic: 'Draft review', summary: 'Reviewed the draft.' }); await settle();
  }
  await consumer.inferSessionTopic(payload);
  const restarted = await service(() => {});
  await (restarted as unknown as typeof consumer).inferSessionTopic(payload);
  expect(summary).toHaveBeenCalledTimes(1);
  expect(getSession(payload.sessionId)!.summary).toBe('Reviewed the draft.');
});


test('a throwing session-end listener does not discard the summary or the next session', async () => {
  const events: AwarenessEvent[] = [];
  const value = await service(event => {
    events.push(event);
    if (event.type === 'session_ended') throw new Error('synthetic listener failure');
  });
  const start = Date.now() - 240000;
  await capture(value, start);
  const id = value.getCurrentSession()!.id;
  await capture(value, start + 180000, 'Browser'); await settle();
  expect(getSession(id)!.summary).toBe('Reviewed the draft.');
  expect(events.filter(event => event.type === 'session_started')).toHaveLength(2);
  expect(value.getCurrentSession()!.id).not.toBe(id);
  expect(summary).toHaveBeenCalledTimes(1);
});

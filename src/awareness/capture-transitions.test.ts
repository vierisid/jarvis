import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { AwarenessService } from './service.ts';
import { AwarenessIntelligence } from './intelligence.ts';
import { createEntity } from '../vault/entities.ts';
import { createFact } from '../vault/facts.ts';
import { ContextTracker } from './context-tracker.ts';
import type { AwarenessEvent } from './types.ts';
import type { AwarenessConfig, JarvisConfig } from '../config/types.ts';
import type { LLMManager } from '../llm/manager.ts';
import type { SidecarEvent } from '../sidecar/protocol.ts';
import { closeDb, initDatabase } from '../vault/schema.ts';
import { getRecentCaptures, getSession } from '../vault/awareness.ts';

const config: AwarenessConfig = {
  enabled: true, capture_interval_ms: 15000, min_change_threshold: 0.02,
  cloud_vision_enabled: false, cloud_vision_cooldown_ms: 30000,
  cloud_vision_ambient_cooldown_ms: 900000, stuck_threshold_ms: 300000,
  suggestion_rate_limit_ms: 60000, retention: { full_hours: 24, key_moment_hours: 72 },
  struggle_grace_ms: 120000, struggle_cooldown_ms: 180000, overlay_autolaunch: false,
};
let service: AwarenessService;
let events: AwarenessEvent[];
let time: number;
beforeEach(async () => {
  initDatabase(':memory:', { quiet: true });
  events = [];
  time = Date.now() - 10000;
  service = new AwarenessService({ awareness: config } as JarvisConfig,
    {} as LLMManager, event => events.push(event));
  await service.start();
});
afterEach(async () => { await service.stop(); closeDb(); });

// Round-trip the actual SidecarEvent wire shape (including numeric capture IDs).
function send(eventType: string, timestamp: number, payload: Record<string, unknown>, sidecar = 'desktop') {
  const event: SidecarEvent = JSON.parse(JSON.stringify({ type: 'sidecar_event',
    event_type: eventType, timestamp, priority: 'normal', payload }));
  return service.handleSidecarEvent(sidecar, event);
}
function capture(id: number, app?: string, title?: string, sidecar = 'desktop') {
  return send('screen_capture', time + id * 100, { capture_id: id,
    image_path: `/fixture/${id}.png`, pixel_change_pct: 0.4, ocr_text: 'same screen text',
    app_name: app, window_title: title }, sidecar);
}
function hint(timestamp: number, app: string, title: string, sidecar = 'desktop') {
  return send('context_changed', timestamp, { from_app: 'Editor', from_window: 'Draft - Editor',
    to_app: app, to_window: title }, sidecar);
}
const transitions = () => events.filter(event => event.type === 'context_changed');

test('serialized captures preserve a real transition and the ended session identity', async () => {
  await capture(1, 'Editor', 'Draft - Editor');
  const firstSession = service.getCurrentSession()!.id;
  await capture(2, 'Browser', 'Inbox - Browser');
  expect(transitions()).toEqual([{ type: 'context_changed', timestamp: time + 200,
    data: { fromApp: 'Editor', toApp: 'Browser', fromWindow: 'Draft - Editor', toWindow: 'Inbox - Browser' } }]);
  expect(service.getCurrentSession()!.id).not.toBe(firstSession);
  expect(getSession(firstSession)!.ended_at).not.toBeNull();
  expect(events.find(event => event.type === 'session_ended')!.data)
    .toEqual({ sessionId: firstSession, apps: ['Editor'] });
  expect(getRecentCaptures(2).map(row => row.app_name)).toEqual(['Browser', 'Editor']);
});

test('native app identity takes precedence over an opaque window title', async () => {
  await capture(1, 'Editor', 'Untitled');
  await capture(2, 'Browser', 'Untitled');
  expect(transitions()).toHaveLength(1);
  expect(transitions()[0]!.data).toMatchObject({ fromApp: 'Editor', toApp: 'Browser' });
  expect(service.getLiveContext()).toMatchObject({ currentApp: 'Browser', currentWindow: 'Untitled' });
});

test.each(['before', 'after'] as const)('explicit context notifications %s the capture do not erase or duplicate it', async order => {
  await capture(1, 'Editor', 'Draft - Editor');
  if (order === 'before') await hint(time + 150, 'Browser', 'Inbox - Browser');
  await capture(2, 'Browser', 'Inbox - Browser');
  if (order === 'after') await hint(time + 250, 'Browser', 'Inbox - Browser');
  await hint(time + 250, 'Browser', 'Inbox - Browser');
  await capture(3, 'Browser', 'Inbox - Browser');
  expect(transitions()).toHaveLength(1);
  expect(transitions()[0]!.data).toMatchObject({ fromApp: 'Editor', toApp: 'Browser' });
  expect(events.filter(event => event.type === 'session_started')).toHaveLength(2);
});

test('a title-only transition keeps native app identity and repeated captures stay silent', async () => {
  await capture(1, 'Browser', 'First tab');
  await capture(2, 'Browser', 'Second tab');
  await capture(3, 'Browser', 'Second tab');
  expect(transitions()).toHaveLength(1);
  expect(transitions()[0]!.data).toEqual({ fromApp: 'Browser', toApp: 'Browser', fromWindow: 'First tab', toWindow: 'Second tab' });
});

test('a genuine return to the same app is not removed by deduplication', async () => {
  await capture(1, 'Editor', 'Draft - Editor');
  await capture(2, 'Browser', 'Inbox - Browser');
  await capture(3, 'Editor', 'Draft - Editor');
  expect(transitions().map(event => [event.data.fromApp, event.data.toApp]))
    .toEqual([['Editor', 'Browser'], ['Browser', 'Editor']]);
});

test('explicit hints supply missing capture metadata without mutating the previous capture', async () => {
  await capture(1, 'Editor', 'Draft - Editor');
  await hint(time + 150, 'Browser', 'Inbox');
  expect(service.getLiveContext().currentApp).toBe('Editor');
  expect(transitions()).toHaveLength(0); // Captures are the canonical producer.
  await capture(2);
  expect(transitions()[0]!.data).toEqual({ fromApp: 'Editor', toApp: 'Browser', fromWindow: 'Draft - Editor', toWindow: 'Inbox' });
  await capture(3);
  expect(transitions()).toHaveLength(1);
  expect(getRecentCaptures(1)[0]!.app_name).toBe('Browser');
});

test('a stale explicit hint cannot revert a newer capture', async () => {
  await capture(1, 'Editor', 'Draft - Editor');
  await capture(2, 'Browser', 'Inbox - Browser');
  await hint(time + 150, 'Editor', 'Draft - Editor');
  await capture(3);
  expect(service.getLiveContext().currentApp).toBe('Browser');
  expect(transitions()).toHaveLength(1);
});

test('complete capture metadata wins over conflicting hints and consumes them', async () => {
  await capture(1, 'Editor', 'Draft - Editor');
  await hint(time + 150, 'Wrong app', 'Wrong window');
  await capture(2, 'Browser', 'Inbox');
  await capture(3);
  expect(transitions()).toHaveLength(1);
  expect(service.getLiveContext()).toMatchObject({ currentApp: 'Browser', currentWindow: 'Inbox' });
});

test('a future hint waits for a capture at its timestamp', async () => {
  await capture(1, 'Editor', 'Draft - Editor');
  await hint(time + 250, 'Browser', 'Inbox');
  await capture(2);
  expect(transitions()).toHaveLength(0);
  await capture(3);
  expect(transitions()).toHaveLength(1);
  expect(transitions()[0]!.data.toApp).toBe('Browser');
});

test('explicit window hints do not leak into another sidecar capture', async () => {
  await capture(1, 'Editor', 'Draft - Editor');
  await hint(time + 150, 'Foreign app', 'Foreign window', 'other-desktop');
  await capture(2);
  expect(service.getLiveContext().currentApp).toBe('Editor');
  expect(transitions()).toHaveLength(0);
});

test('tracker hints leave previous snapshots intact and retain title-based legacy parsing', () => {
  const tracker = new ContextTracker(config);
  const original = tracker.processCapture('one', 'text', 'Draft - Editor', time).context;
  tracker.updateWindowInfo('Browser', 'Inbox - Browser');
  expect(tracker.getCurrentContext()).toBe(original);
  const changed = tracker.processCapture('two', 'text', 'Inbox - Browser', time + 100);
  expect(tracker.getPreviousContext()).toBe(original);
  expect(changed.context).toMatchObject({ appName: 'Browser', isAppSwitch: true, isSignificantChange: true });
  expect(changed.isRedundant).toBe(false);
  const repeat = tracker.processCapture('three', 'text', 'Inbox - Browser', time + 200);
  expect(repeat.isRedundant).toBe(true);
});

test('capture transitions reach the real knowledge suggestion path', async () => {
  const project = createEntity('project', 'Phoenix');
  createFact(project.id, 'status', 'in review', { source: 'llm_extraction', confidence: 0.7,
    sourceRef: 'conversation:fixture', quote: 'Phoenix is in review', basis: 'reported' });
  await capture(1, 'Editor', 'Draft - Editor');
  await hint(time + 150, 'Browser', 'Phoenix - Browser');
  await capture(2, 'Browser', 'Phoenix - Browser');
  expect(events.filter(event => event.type === 'suggestion_ready' && event.data.type === 'knowledge'))
    .toHaveLength(1);
  expect(events.find(event => event.type === 'suggestion_ready')!.data.body).toContain('in review');
});

test('the first metadata-free capture consumes an explicit native window hint', async () => {
  await hint(time + 50, 'Native application', 'Untitled');
  await capture(1);
  expect(service.getLiveContext()).toMatchObject({ currentApp: 'Native application', currentWindow: 'Untitled' });
  expect(transitions()).toHaveLength(0);
});

test('a delayed hint does not replace a newer pending hint', async () => {
  await capture(1, 'Editor', 'Draft - Editor');
  await hint(time + 180, 'Browser', 'Inbox');
  await hint(time + 150, 'Older app', 'Older window');
  await capture(2);
  expect(transitions()[0]!.data.toApp).toBe('Browser');
});

test('partial capture metadata never borrows a title from a different app', async () => {
  await capture(1, 'Editor', 'Draft - Editor');
  await hint(time + 150, 'Foreign app', 'Foreign window');
  await capture(2, 'Browser');
  expect(service.getLiveContext()).toMatchObject({ currentApp: 'Browser', currentWindow: '' });
  expect(transitions()[0]!.data).toMatchObject({ fromApp: 'Editor', toApp: 'Browser', toWindow: '' });
});

test.each(['title-only', 'app-only'] as const)('partial %s hints and captures retain compatible confirmed metadata', async partial => {
  await capture(1, 'Browser', 'Inbox');
  const sessionId = service.getCurrentSession()!.id;
  const app = partial === 'title-only' ? '' : 'Browser';
  const title = partial === 'app-only' ? '' : 'Inbox';
  await hint(time + 150, app, title);
  await capture(2, app, title);
  expect(service.getLiveContext()).toMatchObject({ currentApp: 'Browser', currentWindow: 'Inbox' });
  await capture(3, 'Browser', 'Inbox');
  expect(transitions()).toHaveLength(0);
  expect(service.getCurrentSession()!.id).toBe(sessionId);
  expect(events.filter(event => event.type === 'session_started')).toHaveLength(1);
  expect(getRecentCaptures(3).map(row => [row.app_name, row.window_title]))
    .toEqual([['Browser', 'Inbox'], ['Browser', 'Inbox'], ['Browser', 'Inbox']]);
});

test.each(['title-only', 'app-only'] as const)('partial %s hints complement captures without losing native identity', async partial => {
  await capture(1, 'Editor', 'Draft');
  await hint(time + 150, partial === 'title-only' ? '' : 'Browser', partial === 'title-only' ? 'Inbox' : '');
  await capture(2, partial === 'title-only' ? 'Browser' : '', partial === 'title-only' ? '' : 'Inbox');
  expect(service.getLiveContext()).toMatchObject({ currentApp: 'Browser', currentWindow: 'Inbox' });
  await capture(3, 'Browser', 'Inbox');
  expect(transitions()).toHaveLength(1);
  expect(transitions()[0]!.data).toEqual({ fromApp: 'Editor', toApp: 'Browser', fromWindow: 'Draft', toWindow: 'Inbox' });
});

test.each(['title-only', 'app-only'] as const)('a conflicting %s hint cannot borrow confirmed fields from another window', async partial => {
  await capture(1, 'Browser', 'Inbox');
  await hint(time + 150, partial === 'title-only' ? '' : 'Editor', partial === 'title-only' ? 'Draft - Editor' : '');
  await capture(2);
  expect(service.getLiveContext()).toMatchObject({ currentApp: 'Editor',
    currentWindow: partial === 'title-only' ? 'Draft - Editor' : '' });
  expect(transitions()).toHaveLength(1);
  expect(transitions()[0]!.data.toApp).toBe('Editor');
});

test('native app identity keeps a title change out of the app-switch escalation path', () => {
  const tracker = new ContextTracker(config);
  tracker.processCapture('one', 'text', 'First tab', time, { appName: 'Browser' });
  const second = tracker.processCapture('two', 'text', 'Second tab', time + 100, { appName: 'Browser' });
  expect(second.context).toMatchObject({ appName: 'Browser', isAppSwitch: false, isSignificantChange: true });
  expect(second.isRedundant).toBe(false);
  const third = tracker.processCapture('three', 'text', 'Second tab', time + 200, { appName: 'Browser' });
  expect(third.isRedundant).toBe(true);
});

test('delayed cloud analysis retains the predecessor of its own capture', async () => {
  await service.stop();
  let finishFetch!: (image: Buffer | null) => void;
  const pendingImage = new Promise<Buffer | null>(resolve => { finishFetch = resolve; });
  const analyze = spyOn(AwarenessIntelligence.prototype, 'analyzeDelta').mockResolvedValue('');
  service = new AwarenessService({ awareness: { ...config, cloud_vision_enabled: true,
    cloud_vision_cooldown_ms: 0, cloud_vision_ambient_cooldown_ms: 0 } } as JarvisConfig,
    {} as LLMManager, event => events.push(event), null,
    async (_sidecar, path) => path === '/fixture/2.png' ? pendingImage : null);
  await service.start();
  let second: Promise<void> | undefined;
  try {
    await capture(1, 'Editor', 'Draft - Editor');
    second = capture(2, 'Browser', 'Inbox - Browser');
    await capture(3, 'Terminal', 'Shell - Terminal');
    finishFetch(Buffer.from('synthetic-image'));
    await second;
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(analyze.mock.calls[0]![1]).toMatchObject({ captureId: '2', appName: 'Browser' });
    expect(analyze.mock.calls[0]![2]).toMatchObject({ captureId: '1', appName: 'Editor' });
  } finally {
    finishFetch(null);
    await second;
    analyze.mockRestore();
  }
});

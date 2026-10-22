/**
 * #905: desktop.enabled: false covers the desktop observers. Awareness keeps
 * its own awareness.enabled, but while desktop control is off every capture the
 * sidecar sends is dropped unread: nothing is stored and no event fires. With
 * the switch on (the default) the same capture is stored as before.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { AwarenessService } from './service.ts';
import type { AwarenessEvent } from './types.ts';
import type { AwarenessConfig, JarvisConfig } from '../config/types.ts';
import type { LLMManager } from '../llm/manager.ts';
import type { SidecarEvent } from '../sidecar/protocol.ts';
import { closeDb, initDatabase } from '../vault/schema.ts';
import { getRecentCaptures } from '../vault/awareness.ts';
import { setDesktopEnabledSource } from '../actions/tools/desktop-guard.ts';

const config: AwarenessConfig = {
  enabled: true, capture_interval_ms: 15000, min_change_threshold: 0.02,
  cloud_vision_enabled: false, cloud_vision_cooldown_ms: 30000,
  cloud_vision_ambient_cooldown_ms: 900000, stuck_threshold_ms: 300000,
  suggestion_rate_limit_ms: 60000, retention: { full_hours: 24, key_moment_hours: 72 },
  struggle_grace_ms: 120000, struggle_cooldown_ms: 180000, overlay_autolaunch: false,
};

let desktopOn = true;
let service: AwarenessService;
let events: AwarenessEvent[];
beforeEach(async () => {
  desktopOn = true;
  setDesktopEnabledSource(() => desktopOn);
  initDatabase(':memory:', { quiet: true });
  events = [];
  service = new AwarenessService({ awareness: config } as JarvisConfig, {} as LLMManager, (event) => events.push(event));
  await service.start();
});
afterEach(async () => {
  await service.stop();
  closeDb();
  setDesktopEnabledSource(null);
});

function capture(id: number): Promise<void> {
  const event: SidecarEvent = JSON.parse(JSON.stringify({ type: 'sidecar_event', event_type: 'screen_capture',
    timestamp: Date.now() + id, priority: 'normal', payload: { capture_id: id, image_path: `/fixture/${id}.png`,
      pixel_change_pct: 0.4, ocr_text: 'secret on screen', app_name: 'Editor', window_title: 'Draft - Editor' } }));
  return service.handleSidecarEvent('desktop', event);
}

test('off: a capture is dropped unread', async () => {
  desktopOn = false;
  await capture(1);
  expect(getRecentCaptures(5)).toEqual([]);
  expect(events).toEqual([]);
  expect(service.getCurrentSession()).toBeNull();
});

test('off: window changes and idle reports are dropped too', async () => {
  desktopOn = false;
  for (const [type, payload] of [
    ['context_changed', { from_app: 'Editor', from_window: 'A', to_app: 'Browser', to_window: 'B' }],
    ['idle_detected', { idle_ms: 600000 }],
  ] as const) {
    const event: SidecarEvent = JSON.parse(JSON.stringify({ type: 'sidecar_event', event_type: type, timestamp: Date.now(), priority: 'normal', payload }));
    await service.handleSidecarEvent('desktop', event);
  }
  expect(events).toEqual([]);
  expect(service.getLiveContext()).toMatchObject({ currentApp: null });
});

test('on: the same capture is stored (the fixture is live)', async () => {
  await capture(1);
  expect(getRecentCaptures(5).map((row) => row.app_name)).toEqual(['Editor']);
});

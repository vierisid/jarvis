/**
 * The event types the manager subscribes to are the only ones its listeners
 * ever see. This pins the list, because the recorder commit once replaced
 * it with nine entries and took the pebble, tray, panels, region capture,
 * wake word and realtime voice offline without a single test noticing.
 */
import { describe, expect, test } from 'bun:test';
import { SIDECAR_EVENT_TYPES } from './manager.ts';

const REQUIRED = [
  'screen_capture', 'context_changed', 'idle_detected', 'clipboard_change', 'file_change',
  'process_started', 'process_stopped', 'notification',
  'pebble.summon', 'pebble.palette', 'pebble.blind_toggle', 'pebble.open_answer',
  'panel.bounds_changed', 'panel.closed',
  'audio.session_start', 'audio.session_end', 'audio.wake_segment',
  'region.captured', 'region.cancelled',
  'sub_pebble.clicked', 'sub_pebble.open_full',
  'pebble.realtime_start', 'pebble.realtime_stop', 'pebble.audio_frame', 'pebble.mic_blocked',
  'tray.set_pause', 'tray.set_mute', 'notify.action',
  'ui_interaction', 'ui_recording',
];

describe('sidecar event subscriptions', () => {
  test('every event type a daemon listener depends on is subscribed', () => {
    const missing = REQUIRED.filter((t) => !SIDECAR_EVENT_TYPES.includes(t));
    expect(missing).toEqual([]);
  });

  test('no duplicates', () => {
    expect(new Set(SIDECAR_EVENT_TYPES).size).toBe(SIDECAR_EVENT_TYPES.length);
  });
});

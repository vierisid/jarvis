/**
 * #1159 security review: the generic pipeline checked desktop.enabled when a
 * queued event was DRAINED. A clipboard_change copied while the switch was off
 * and still queued when it was turned back on was then stored and broadcast.
 * It is dropped when it ARRIVES as well.
 */
import { afterEach, expect, test } from 'bun:test';
import type { ServerWebSocket } from 'bun';
import { SidecarConnection } from './connection.ts';
import { EventScheduler } from './scheduler.ts';
import type { SidecarEvent } from './protocol.ts';
import { setDesktopEnabledSource } from '../actions/tools/desktop-guard.ts';

afterEach(() => setDesktopEnabledSource(null));

function setup() {
  const scheduler = new EventScheduler(); // not started: the queue is inspected
  const conn = new SidecarConnection('sc-test', { send: () => {} } as unknown as ServerWebSocket<unknown>, scheduler, () => {});
  const queued = () => ((scheduler as unknown as { queues: Map<string, Array<{ event: SidecarEvent }>> })
    .queues.get('sc-test') ?? []).map(q => q.event.event_type);
  return { conn, queued };
}

const message = (eventType: string) => JSON.stringify({
  type: 'sidecar_event', event_type: eventType, timestamp: Date.now(), payload: { content: 'copied secret' },
});

test('a clipboard_change that arrives while desktop is off is never queued', async () => {
  const { conn, queued } = setup();
  let on = false;
  setDesktopEnabledSource(() => on);
  await conn.handleMessage(message('clipboard_change'));
  await conn.handleMessage(message('file_change'));
  // Turned back on before anything drained: the copy made while off stays gone.
  on = true;
  expect(queued()).toEqual(['file_change']);
});

test('with desktop on it is queued as before', async () => {
  const { conn, queued } = setup();
  setDesktopEnabledSource(() => true);
  await conn.handleMessage(message('clipboard_change'));
  expect(queued()).toEqual(['clipboard_change']);
});

test('screen events that arrive while desktop is off are never queued either (#1159 final review)', async () => {
  // Turning the switch back on in Settings no longer empties the queue with a
  // restart, so a capture sent while off would otherwise be OCR-stored after.
  const { conn, queued } = setup();
  let on = false;
  setDesktopEnabledSource(() => on);
  for (const type of ['screen_capture', 'context_changed', 'idle_detected', 'notification']) await conn.handleMessage(message(type));
  on = true;
  expect(queued()).toEqual(['notification']);
  for (const type of ['screen_capture', 'context_changed', 'idle_detected']) await conn.handleMessage(message(type));
  expect(queued()).toEqual(['notification', 'screen_capture', 'context_changed', 'idle_detected']);
});

/**
 * #1026 item 2: "open <room>" / "close <room>" on the pebble said "Opening X."
 * or "Closing X." whatever happened. The line was mirrored to the dashboard
 * before the RPC ran, a failed panel.spawn was only logged, and a close with
 * no tracked panel logged "close is a no-op", and both then spoke the line
 * anyway. The confirmation now follows the outcome.
 */

import { describe, expect, test } from 'bun:test';
import { makeSpeakConfirmation } from './pebble-confirmation.ts';
import { runRoomPanelIntent, type RoomPanelDeps, type RoomPanelIntent } from './pebble-room-panel.ts';

const SETTINGS_OPEN: RoomPanelIntent = { action: 'open', key: 'settings', title: 'Settings' };
const SETTINGS_CLOSE: RoomPanelIntent = { action: 'close', key: 'settings', title: 'Settings' };

function harness(opts: {
  spawn?: () => Promise<unknown>;
  close?: () => Promise<void>;
  tracked?: Array<{ id: string; key: string; title: string }>;
} = {}) {
  // Everything that reaches the person or the panels, in order.
  const events: string[] = [];
  const ctrl = { cancelled: false };
  const tracked = [...(opts.tracked ?? [])];
  const speak = makeSpeakConfirmation({
    setState: async (_id, state, text) => { events.push(`state:${state}${text ? `:${text}` : ''}`); },
    heartbeat: (text) => { events.push(`heartbeat:${text}`); },
    synthesizer: () => async (text) => { events.push(`synth:${text}`); return Buffer.from('clip'); },
    play: async () => { events.push('play'); },
    hold: async () => {},
  });
  // Cast, not a typed literal: `heartbeat` is extra here once the module
  // stops taking it, and the same file must run against the old module too.
  const deps = {
    setState: async (_id: string, state: string, text?: string) => { events.push(`state:${state}${text ? `:${text}` : ''}`); },
    speak,
    heartbeat: (text: string) => { events.push(`heartbeat:${text}`); },
    openPanel: async () => {
      events.push('rpc:spawn');
      return opts.spawn ? opts.spawn() : { id: 'p1' };
    },
    closePanel: async (_sid: string, id: string) => {
      events.push(`rpc:close:${id}`);
      if (opts.close) await opts.close();
    },
    findPanel: (_sid: string, key: string) => [...tracked].reverse().find((p) => p.key === key) ?? null,
    trackPanel: (_sid: string, entry: { id: string; key: string; title: string }) => { tracked.push(entry); },
    untrackPanel: (_sid: string, id: string) => {
      const i = tracked.findIndex((p) => p.id === id);
      if (i >= 0) tracked.splice(i, 1);
    },
  } as RoomPanelDeps;
  return { events, ctrl, tracked, deps };
}

/** Every line the person could see or hear: bubble, dashboard mirror, speech. */
const said = (events: string[]) => events
  .filter((e) => e.startsWith('heartbeat:') || e.startsWith('synth:') || e.startsWith('state:speaking:'))
  .map((e) => e.slice(e.indexOf(':') + 1).replace(/^speaking:/, ''));

describe('pebble open/close <room> says what happened (#1026)', () => {
  test('a spawn that worked says it opened, only after the spawn, and tracks the panel', async () => {
    const { events, ctrl, tracked, deps } = harness();
    await runRoomPanelIntent(deps, 's1', SETTINGS_OPEN, ctrl);
    const spawnAt = events.indexOf('rpc:spawn');
    const firstLine = events.findIndex((e) => e.startsWith('heartbeat:') || e.startsWith('state:speaking:'));
    expect(spawnAt).toBeGreaterThanOrEqual(0);
    // The bug mirrored "Opening Settings." to the dashboard before the spawn ran.
    expect(firstLine).toBeGreaterThan(spawnAt);
    expect(said(events)).toEqual(['Opened Settings.', 'Opened Settings.', 'Opened Settings.']);
    expect(tracked).toEqual([{ id: 'p1', key: 'settings', title: 'Settings' }]);
  });

  test('a spawn that failed never claims it is opening', async () => {
    const { events, ctrl, tracked, deps } = harness({ spawn: async () => { throw new Error('webview gone'); } });
    await runRoomPanelIntent(deps, 's1', SETTINGS_OPEN, ctrl);
    expect(events).toContain('rpc:spawn');
    expect(said(events).some((t) => /Open(ing|ed)/.test(t))).toBe(false);
    expect(said(events)).toEqual(["I couldn't open Settings.", "I couldn't open Settings.", "I couldn't open Settings."]);
    expect(tracked).toEqual([]);
  });

  test('a close with no tracked panel sends nothing and says so, not "Closing"', async () => {
    const { events, ctrl, deps } = harness();
    await runRoomPanelIntent(deps, 's1', SETTINGS_CLOSE, ctrl);
    expect(events.some((e) => e.startsWith('rpc:'))).toBe(false);
    expect(said(events).some((t) => /Clos/.test(t))).toBe(false);
    expect(new Set(said(events))).toEqual(new Set(["I don't see an open Settings window."]));
  });

  test('a close that worked closes the most recent panel of that room and says so after it', async () => {
    const { events, ctrl, tracked, deps } = harness({
      tracked: [{ id: 'old', key: 'settings', title: 'Settings' }, { id: 'new', key: 'settings', title: 'Settings' }],
    });
    await runRoomPanelIntent(deps, 's1', SETTINGS_CLOSE, ctrl);
    const closeAt = events.indexOf('rpc:close:new');
    const firstLine = events.findIndex((e) => e.startsWith('heartbeat:') || e.startsWith('state:speaking:'));
    expect(closeAt).toBeGreaterThanOrEqual(0);
    expect(firstLine).toBeGreaterThan(closeAt);
    expect(new Set(said(events))).toEqual(new Set(['Closed Settings.']));
    expect(tracked.map((p) => p.id)).toEqual(['old']);
  });

  test('a close RPC that failed does not claim it closed', async () => {
    const { events, ctrl, deps } = harness({
      tracked: [{ id: 'p1', key: 'settings', title: 'Settings' }],
      close: async () => { throw new Error('SIDECAR_ERROR: panel.close[p1]: webview did not respond'); },
    });
    await runRoomPanelIntent(deps, 's1', SETTINGS_CLOSE, ctrl);
    expect(events).toContain('rpc:close:p1');
    expect(said(events).some((t) => /Clos/.test(t))).toBe(false);
    expect(new Set(said(events))).toEqual(new Set(["I couldn't close Settings."]));
  });

  test('a close the sidecar no longer knows drops the dead id and says it is not open; any other failure keeps it', async () => {
    // What the sidecar really sends (panels.go ErrPanelUnknown, wrapped by
    // SidecarRPCError as "<code>: <message>").
    for (const [message, left, reply] of [
      ['SIDECAR_ERROR: panel.close[p1]: panel not found', [], "I don't see an open Settings window."],
      ['timeout', ['p1'], "I couldn't close Settings."],
    ] as const) {
      const h = harness({
        tracked: [{ id: 'p1', key: 'settings', title: 'Settings' }],
        close: async () => { throw new Error(message); },
      });
      await runRoomPanelIntent(h.deps, 's1', SETTINGS_CLOSE, h.ctrl);
      expect(h.tracked.map((p) => p.id)).toEqual([...left]);
      expect(new Set(said(h.events))).toEqual(new Set([reply]));
    }
  });

  test('the dashboard hears each outcome once, from the confirmation itself', async () => {
    for (const h of [
      harness(),
      harness({ spawn: async () => { throw new Error('x'); } }),
    ]) {
      await runRoomPanelIntent(h.deps, 's1', SETTINGS_OPEN, h.ctrl);
      expect(h.events.filter((e) => e.startsWith('heartbeat:'))).toHaveLength(1);
    }
  });

  test('a turn cancelled before it starts does nothing at all', async () => {
    const { events, ctrl, deps } = harness();
    ctrl.cancelled = true;
    await runRoomPanelIntent(deps, 's1', SETTINGS_OPEN, ctrl);
    expect(events).toEqual([]);
  });

  test('a turn cancelled while the spawn runs says nothing about it', async () => {
    const h = harness({ spawn: async () => { h.ctrl.cancelled = true; return { id: 'p1' }; } });
    await runRoomPanelIntent(h.deps, 's1', SETTINGS_OPEN, h.ctrl);
    expect(said(h.events)).toEqual([]);
    // The window did open, so it is still tracked for "close it".
    expect(h.tracked.map((p) => p.id)).toEqual(['p1']);
  });
});

/**
 * #975: the pebble's room panels open from keys someone else supplied, the
 * realtime model's tool arguments or the body of POST /api/palette/pick. The
 * room table is a plain object, so a lookup by key also found what every
 * object inherits: "constructor" opened a broken #/_panel_constructor panel,
 * and a window action named "constructor" sent the sidecar a function as the
 * window state.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { makePalettePick, makePebbleNavTool, type PebblePanelEntry } from './pebble-nav-tool.ts';
import { PEBBLE_ROOMS } from './pebble-intents.ts';

/** Every key a plain object answers to without holding it. */
const INHERITED = Object.getOwnPropertyNames(Object.prototype);

function harness(open: PebblePanelEntry[] = []) {
  const rpcs: { method: string; params: Record<string, unknown> }[] = [];
  const tracked: PebblePanelEntry[] = [];
  const deps = {
    dispatchRPC: async (_sidecarId: string, method: string, params: Record<string, unknown>) => {
      rpcs.push({ method, params });
      return method === 'panel.spawn' ? { id: `panel-${rpcs.length}` } : {};
    },
    dashboardURL: (key: string) => `http://dash/#/_panel_${key}`,
    boundsForRoom: (_key: string, w: number, h: number) => ({ x: -1, y: -1, w, h }),
    trackPanel: (_sidecarId: string, entry: PebblePanelEntry) => { tracked.push(entry); },
  };
  const nav = makePebbleNavTool({
    ...deps,
    untrackPanel: () => {},
    findPanel: () => open[open.length - 1] ?? null,
  });
  const closed: string[] = [];
  const pick = makePalettePick({
    ...deps,
    pickSidecar: () => 's1',
    closePalette: async (sid) => { closed.push(sid); },
  });
  return { nav, pick, rpcs, tracked, closed };
}

describe('open_dashboard_room and dashboard_room_action', () => {
  test('the inherited-key list is not empty', () => {
    // Guards the loops below against passing over nothing.
    expect(INHERITED).toContain('constructor');
    expect(INHERITED).toContain('__proto__');
    expect(INHERITED.length).toBeGreaterThan(5);
  });

  test.each(INHERITED)('"%s" is not a room: no panel is opened', async (key) => {
    const h = harness();
    expect(await h.nav('s1', 'open_dashboard_room', { room: key })).toBe(`I don't have a "${key}" screen.`);
    expect(await h.nav('s1', 'dashboard_room_action', { room: key, action: 'enable_tts' }))
      .toBe(`I don't have a "${key}" screen. I did not run "enable_tts" inside it; tell the user it has not been done.`);
    expect(h.rpcs).toEqual([]);
    expect(h.tracked).toEqual([]);
  });

  test('a real room still opens, tracked under its key', async () => {
    const h = harness();
    expect(await h.nav('s1', 'open_dashboard_room', { room: 'workflows' })).toBe('Opened Workflows.');
    expect(h.rpcs).toEqual([{
      method: 'panel.spawn',
      params: {
        url: 'http://dash/#/_panel_workflows', title: 'Workflows', bounds: { x: -1, y: -1, w: 900, h: 600 },
        resizable: true, always_on_top: false, multi_instance: false,
      },
    }]);
    expect(h.tracked).toEqual([{ id: 'panel-1', key: 'workflows', title: 'Workflows' }]);
  });

  test('every room in the table opens', async () => {
    for (const key of Object.keys(PEBBLE_ROOMS)) {
      const h = harness();
      expect(await h.nav('s1', 'open_dashboard_room', { room: key })).toBe(`Opened ${PEBBLE_ROOMS[key]!.title}.`);
    }
  });

  test('dashboard_room_action opens the room and says the action was not run (#965)', async () => {
    const h = harness();
    expect(await h.nav('s1', 'dashboard_room_action', { room: 'settings', action: 'disable_tts' }))
      .toBe('Opened Settings. I did not run "disable_tts" inside it; tell the user it has not been done.');
    expect(h.rpcs.map((r) => r.method)).toEqual(['panel.spawn']);
  });

  test('a tool that is not a nav tool falls through', async () => {
    expect(await harness().nav('s1', 'web_search', {})).toBeNull();
  });
});

describe('control_dashboard_window', () => {
  const open = [{ id: 'p1', key: 'settings', title: 'Settings' }];

  test.each(INHERITED)('"%s" is not a window action: nothing is sent', async (action) => {
    const h = harness(open);
    expect(await h.nav('s1', 'control_dashboard_window', { action })).toBe("I'm not sure how to do that with the window.");
    expect(h.rpcs).toEqual([]);
  });

  test('a real window action is still sent', async () => {
    const h = harness(open);
    expect(await h.nav('s1', 'control_dashboard_window', { action: 'minimize' })).toBe('Done.');
    expect(h.rpcs).toEqual([{ method: 'panel.set_window_state', params: { id: 'p1', state: 'minimized' } }]);
  });
});

describe('palette room pick', () => {
  test.each(INHERITED)('"%s" is not a room: the palette stays and no panel opens', async (key) => {
    const h = harness();
    await h.pick({ kind: 'room', key });
    expect(h.closed).toEqual([]);
    expect(h.rpcs).toEqual([]);
  });

  test('a key that is not a string is not a room, even one that reads as one', async () => {
    // POST /api/palette/pick only checks the key is truthy; ["settings"]
    // coerces to "settings" for Object.hasOwn, but was tracked as an array
    // that no later "close the settings window" could find.
    for (const key of [['settings'], { toString: () => 'settings' }, 7]) {
      const h = harness();
      await h.pick({ kind: 'room', key: key as never });
      expect([key, h.closed, h.rpcs]).toEqual([key, [], []]);
    }
  });

  test('a real room closes the palette and opens the room', async () => {
    const h = harness();
    await h.pick({ kind: 'room', key: 'agent_strip' });
    expect(h.closed).toEqual(['s1']);
    expect(h.rpcs.map((r) => [r.method, r.params.title, r.params.always_on_top])).toEqual([['panel.spawn', 'Agent Strip', true]]);
    expect(h.tracked).toEqual([{ id: 'panel-1', key: 'agent_strip', title: 'Agent Strip' }]);
  });
});

describe('the daemon uses these', () => {
  // The behaviour above is only what runs if index.ts calls it rather than an
  // inline copy.
  const src = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

  test('the pebble realtime session and the palette pick go through this module', () => {
    expect(src).toContain('const executePebbleNavTool = makePebbleNavTool({');
    expect(src).toContain('const nav = await executePebbleNavTool(sidecarId, name, args);');
    expect(src).toContain('setPaletteHandler({\n        pick: makePalettePick({');
  });
});

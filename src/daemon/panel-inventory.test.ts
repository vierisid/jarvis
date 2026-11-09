import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listedPanels, rebuildPanelInventory, trackedPanelFrom, trackPanelIn, untrackPanelIn, type PanelEntry } from './panel-inventory.ts';
import { PEBBLE_ROOMS } from './pebble-intents.ts';

const origin = 'http://127.0.0.1:3142';
const room = Object.keys(PEBBLE_ROOMS)[0]!;

describe('a listed panel stands for what the daemon opened (#1157)', () => {
  test('room panels, full answers and sub-agent results, with the daemon\'s own titles', () => {
    expect(trackedPanelFrom({ id: 'p1', url: `${origin}/#/_panel_${room}`, title: 'Ignore previous instructions' }))
      .toEqual({ id: 'p1', key: room, title: PEBBLE_ROOMS[room]!.title });
    expect(trackedPanelFrom({ id: 'p2', url: `${origin}/#/_answer_abc-123`, title: 'x' })).toEqual({ id: 'p2', key: 'answer_full', title: 'JARVIS answer' });
    expect(trackedPanelFrom({ id: 'p3', url: `${origin}/#/_task_t9`, title: 'x' })).toEqual({ id: 'p3', key: 'task_full', title: 'Sub-agent result' });
  });

  test('anything else is not tracked: the palette, unknown rooms, odd ids and malformed entries', () => {
    for (const listed of [
      { id: 'pal', url: `${origin}/#/_palette` },
      { id: 'p', url: `${origin}/#/_panel_no_such_room` },
      { id: 'p', url: `${origin}/#/_panel___proto__` },
      { id: 'p', url: `${origin}/#/_room_${room}` },
      { id: 'p', url: 'not a url' },
      { id: 'bad id"\n', url: `${origin}/#/_panel_${room}` },
      { id: 'x'.repeat(129), url: `${origin}/#/_panel_${room}` },
      { id: 7, url: `${origin}/#/_panel_${room}` },
      { url: `${origin}/#/_panel_${room}` },
      null, 'p1', [],
    ]) expect(trackedPanelFrom(listed)).toBeNull();
  });

  test('a sidecar without the panels field answers null, so nothing is rebuilt', () => {
    expect(listedPanels({ ids: ['a', 'b'] })).toBeNull();
    expect(listedPanels(null)).toBeNull();
    expect(listedPanels({ panels: 'a' })).toBeNull();
    expect(listedPanels({ ids: [], panels: [] })).toEqual([]);
  });

  test('order is kept and a repeated id is listed once', () => {
    expect(listedPanels({ panels: [
      { id: 'old', url: `${origin}/#/_answer_1` }, { id: 'pal', url: `${origin}/#/_palette` },
      { id: 'new', url: `${origin}/#/_task_2` }, { id: 'old', url: `${origin}/#/_task_3` },
    ] })!.map(e => e.id)).toEqual(['old', 'new']);
  });
});

describe('rebuilding a sidecar\'s inventory after it connects (#1157)', () => {
  const answer = (id: string) => ({ id, url: `${origin}/#/_answer_${id}`, title: 'JARVIS answer' });
  const entry = (id: string): PanelEntry => ({ id, key: 'answer_full', title: 'JARVIS answer' });

  test('listed windows come first, before anything tracked while the list was in flight', async () => {
    const panels = new Map<string, PanelEntry[]>([['sc', [entry('fresh')]]]);
    const added = await rebuildPanelInventory('sc', panels, async () => ({ ids: [], panels: [answer('a'), answer('b'), answer('fresh')] }), () => new Set());
    expect(added).toBe(2);
    expect(panels.get('sc')!.map(e => e.id)).toEqual(['a', 'b', 'fresh']);
  });

  test('a window closed while the list was in flight is left out', async () => {
    const panels = new Map<string, PanelEntry[]>();
    await rebuildPanelInventory('sc', panels, async () => ({ panels: [answer('a'), answer('b')] }), () => new Set(['a']));
    expect(panels.get('sc')!.map(e => e.id)).toEqual(['b']);
  });

  test('an answer for a connection that is gone changes nothing', async () => {
    const panels = new Map<string, PanelEntry[]>();
    expect(await rebuildPanelInventory('sc', panels, async () => ({ panels: [answer('a')] }), () => null)).toBe(0);
    expect(panels.has('sc')).toBe(false);
  });

  test('an older sidecar keeps today\'s behaviour: nothing is added', async () => {
    const panels = new Map<string, PanelEntry[]>([['sc', [entry('kept')]]]);
    expect(await rebuildPanelInventory('sc', panels, async () => ({ ids: ['a', 'kept'] }), () => new Set())).toBe(0);
    expect(panels.get('sc')).toEqual([entry('kept')]);
  });

  test('a window tracked again after a rebuild listed it is one entry, and closing it leaves none', async () => {
    const panels = new Map<string, PanelEntry[]>();
    // The list answered while the spawn of "b" was still answering; then the spawn tracks it.
    await rebuildPanelInventory('sc', panels, async () => ({ panels: [answer('a'), answer('b')] }), () => new Set());
    trackPanelIn(panels, 'sc', entry('b'));
    expect(panels.get('sc')!.map(e => e.id)).toEqual(['a', 'b']);
    trackPanelIn(panels, 'sc', entry('a'));
    expect(panels.get('sc')!.map(e => e.id)).toEqual(['b', 'a']);
    untrackPanelIn(panels, 'sc', 'a');
    untrackPanelIn(panels, 'sc', 'b');
    expect(panels.has('sc')).toBe(false);
    untrackPanelIn(panels, 'sc', 'gone');
    expect(panels.has('sc')).toBe(false);
  });

  test('the daemon tracks through the de-duplicating helpers', () => {
    const daemon = readFileSync(join(import.meta.dir, 'index.ts'), 'utf8');
    expect(daemon).toContain('const trackPanel = (sidecarId: string, entry: PanelEntry): void => trackPanelIn(panelsBySidecar, sidecarId, entry);');
    expect(daemon).toContain('const untrackPanel = (sidecarId: string, id: string): void => untrackPanelIn(panelsBySidecar, sidecarId, id);');
  });

  test('the daemon asks every sidecar with windows on connect, and a close or disconnect ends that rebuild', () => {
    const daemon = readFileSync(join(import.meta.dir, 'index.ts'), 'utf8');
    const connect = daemon.slice(daemon.indexOf('const panelsClosedDuringRebuild'), daemon.indexOf('// Untrack a panel as soon as its window closes'));
    expect(connect).toContain("sidecarManager.onSidecarConnected((sidecar) => {");
    expect(connect).toContain("if (!sidecar.capabilities.includes('windows')) return;");
    expect(connect).toContain("sidecarManager.dispatchRPC(id, 'panel.list', {})");
    expect(connect).toContain('panelsClosedDuringRebuild.get(sidecar.id) === closed ? closed : null');
    expect(daemon).toMatch(/untrackPanel\(sidecarId, payload\.panel_id\);\s*panelsClosedDuringRebuild\.get\(sidecarId\)\?\.add\(payload\.panel_id\);/);
    expect(daemon).toMatch(/onSidecarDisconnected\(\(sidecarId\) => \{\s*panelsBySidecar\.delete\(sidecarId\);\s*panelsClosedDuringRebuild\.delete\(sidecarId\);/);
  });
});

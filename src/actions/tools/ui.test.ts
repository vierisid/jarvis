import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { uiSnapshotTool, uiActTool, resetUiSnapshots, parsePostcondition } from './ui.ts';
import { getSidecarManager, setSidecarManagerRef } from './sidecar-route.ts';
import type { SidecarManager } from '../../sidecar/manager.ts';
import { semanticNodeFromUia, type UiaSemanticElement } from '../../structural/types.ts';

const priorManager = getSidecarManager();
afterAll(() => {
  setSidecarManagerRef(priorManager as unknown as SidecarManager);
});

function el(id: number, name: string, extra: Partial<UiaSemanticElement> = {}): UiaSemanticElement {
  return {
    id,
    name,
    automation_id: '',
    class_name: 'Button',
    control_type: 'Button',
    enabled: true,
    focusable: true,
    rect: { x: 0, y: id * 30, w: 100, h: 24 },
    patterns: ['Invoke'],
    depth: 1,
    path: [{ role: 'Window', name: 'Notepad' }],
    ordinal: 0,
    sig: `sig-${name}`,
    ...extra,
  };
}

type Call = { method: string; params: Record<string, unknown> };

/**
 * A sidecar that answers get_window_tree from a queue of trees, so a test can
 * make the element ids move between the model's snapshot and the capture
 * ui_act takes before acting, or make a surface settle across the
 * verification re-reads. The last tree repeats once the queue runs dry.
 */
function fakeManager(trees: UiaSemanticElement[][], calls: Call[], titles: string[] = []): SidecarManager {
  const queue = [...trees];
  const titleQueue = [...titles];
  return {
    listSidecars: () => [{
      id: 'sc1', name: 'desktop-pc', connected: true,
      capabilities: ['desktop', 'browser'], unavailable_capabilities: [],
    }],
    dispatchRPC: async (_id: string, method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === 'get_window_tree') {
        const elements = queue.length > 1 ? queue.shift()! : queue[0]!;
        const title = titleQueue.length > 1 ? titleQueue.shift()! : (titleQueue[0] ?? 'Untitled - Notepad');
        return { window_title: title, pid: 42, elements };
      }
      if (method === 'browser_ax_snapshot') {
        return { url: 'https://x.test', title: 'x', elements: [] };
      }
      return { success: true };
    },
  } as unknown as SidecarManager;
}

const acts = (calls: Call[]) => calls.filter((c) => c.method === 'click_element');
const captures = (calls: Call[]) => calls.filter((c) => c.method === 'get_window_tree');
/** The [id] ui_snapshot printed for the element named `name`. */
function idOf(snapshot: string, name: string): number {
  const line = snapshot.split('\n').find((l) => l.includes(`"${name}"`));
  if (!line) throw new Error(`no line for "${name}" in:\n${snapshot}`);
  return Number(line.match(/^\[(\d+)\]/)![1]);
}

describe('ui_act resolves the model\'s [id] by durable ref, on the window it was taken from', () => {
  beforeEach(() => resetUiSnapshots());

  it('refuses to act when no ui_snapshot has been taken', async () => {
    const calls: Call[] = [];
    setSidecarManagerRef(fakeManager([[el(1, 'Send')]], calls));
    const out = await uiActTool.execute({ element_id: 1 }) as string;
    expect(out).toContain('no ui_snapshot has been taken');
    expect(acts(calls)).toHaveLength(0);
  });

  it('acts on the live id after the tree re-numbered, and on the snapshot\'s pid', async () => {
    const calls: Call[] = [];
    // Snapshot: Send is [2]. Before acting, a banner appeared so Send is [3].
    setSidecarManagerRef(fakeManager([
      [el(1, 'File'), el(2, 'Send')],
      [el(1, 'File'), el(2, 'Update available'), el(3, 'Send')],
    ], calls));
    const snap = await uiSnapshotTool.execute({ kind: 'desktop', pid: 42 }) as string;
    const sendId = idOf(snap, 'Send');

    const out = await uiActTool.execute({ element_id: sendId, action: 'click' }) as string;
    expect(acts(calls)[0]!.params.element_id).toBe(3);
    expect(out).toContain(`Acted: click on [${sendId}] Button "Send"`);
    expect(captures(calls).length).toBeGreaterThanOrEqual(2);
    for (const c of captures(calls)) expect(c.params.pid).toBe(42);
  });

  it('does nothing when the element is gone from the surface', async () => {
    const calls: Call[] = [];
    setSidecarManagerRef(fakeManager([
      [el(1, 'File'), el(2, 'Send')],
      [el(1, 'File'), el(2, 'Discard')],
    ], calls));
    const snap = await uiSnapshotTool.execute({ kind: 'desktop' }) as string;
    const out = await uiActTool.execute({ element_id: idOf(snap, 'Send') }) as string;
    expect(out).toContain('no longer on the surface');
    expect(out).toContain('nothing was done');
    expect(acts(calls)).toHaveLength(0);
  });

  it('rejects an [id] that no snapshot ever produced', async () => {
    const calls: Call[] = [];
    setSidecarManagerRef(fakeManager([[el(1, 'File')]], calls));
    await uiSnapshotTool.execute({ kind: 'desktop' });
    const out = await uiActTool.execute({ element_id: 9999 }) as string;
    expect(out).toContain('not from any recent ui_snapshot');
    expect(acts(calls)).toHaveLength(0);
  });

  it('never turns a read-only browser action into a click', async () => {
    const calls: Call[] = [];
    setSidecarManagerRef(fakeManager([[el(1, 'Search')]], calls));
    // A browser snapshot the ids come from, so the refusal is about the
    // action and not about an unknown id.
    setSidecarManagerRef({
      listSidecars: () => [{ id: 'sc1', name: 'desktop-pc', connected: true, capabilities: ['browser'], unavailable_capabilities: [] }],
      dispatchRPC: async (_i: string, method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        if (method === 'browser_ax_snapshot') {
          return { url: 'https://x.test', title: 'x', elements: [{ ax_id: 'a', backend_node_id: 7, role: 'textbox', name: 'Search', interactive: true, sig: 's7' }] };
        }
        return { success: true };
      },
    } as unknown as SidecarManager);
    const snap = await uiSnapshotTool.execute({ kind: 'browser' }) as string;
    const out = await uiActTool.execute({ element_id: idOf(snap, 'Search'), action: 'get_value' }) as string;
    expect(out).toContain('not available for kind="browser"');
    expect(calls.some((c) => c.method === 'browser_ax_click' || c.method === 'browser_ax_set_value')).toBe(false);
  });

  it('ids from two snapshots of the same sidecar never alias each other', async () => {
    // Two orchestrators (chat and the background agent) share this module. A
    // snapshot taken between another agent's snapshot and its act must not
    // re-point that agent's [id] at a different element.
    const calls: Call[] = [];
    setSidecarManagerRef(fakeManager([
      [el(1, 'File'), el(2, 'Send')],      // agent A's snapshot
      [el(1, 'File'), el(2, 'Discard')],   // agent B's snapshot, same provider ids
      [el(1, 'File'), el(2, 'Send'), el(3, 'Discard')],
    ], calls));
    const snapA = await uiSnapshotTool.execute({ kind: 'desktop' }) as string;
    const sendId = idOf(snapA, 'Send');
    const snapB = await uiSnapshotTool.execute({ kind: 'desktop' }) as string;
    expect(idOf(snapB, 'Discard')).not.toBe(sendId);

    const out = await uiActTool.execute({ element_id: sendId, action: 'click' }) as string;
    expect(out).toContain('"Send"');
    expect(out).not.toContain('"Discard"' + ' (re-found');
    expect(acts(calls)[0]!.params.element_id).toBe(2); // Send on the live tree
  });
});

describe('ui_act self-heal re-observes and never re-dispatches', () => {
  beforeEach(() => resetUiSnapshots());

  it('dispatches exactly once when the postcondition never holds', async () => {
    const calls: Call[] = [];
    // Send stays on the surface forever, so element_gone can never hold.
    setSidecarManagerRef(fakeManager([[el(1, 'File'), el(2, 'Send')]], calls));
    const snap = await uiSnapshotTool.execute({ kind: 'desktop' }) as string;
    const out = await uiActTool.execute({
      element_id: idOf(snap, 'Send'), action: 'click', verify: 'element_gone',
    }) as string;

    // The whole point: a click that may already have sent the mail is not
    // sent again to "heal" it.
    expect(acts(calls)).toHaveLength(1);
    expect(out).toContain('NOT VERIFIED');
    expect(out).toContain('was NOT repeated');
    // It did climb the ladder - three re-reads plus the pre-act capture.
    expect(captures(calls).length).toBe(5);
  });

  it('does not re-dispatch even when the element renumbers between re-reads', async () => {
    const calls: Call[] = [];
    // Every re-read renumbers Send: the old re_resolve rung fired a second
    // click precisely here, because the live id had changed.
    setSidecarManagerRef(fakeManager([
      [el(1, 'File'), el(2, 'Send')],
      [el(1, 'File'), el(2, 'Send')],
      [el(1, 'File'), el(9, 'Banner'), el(3, 'Send')],
      [el(1, 'File'), el(9, 'Banner'), el(8, 'Other'), el(4, 'Send')],
      [el(1, 'File'), el(5, 'Send')],
    ], calls));
    const snap = await uiSnapshotTool.execute({ kind: 'desktop' }) as string;
    await uiActTool.execute({ element_id: idOf(snap, 'Send'), action: 'click', verify: 'element_gone' });
    expect(acts(calls)).toHaveLength(1);
  });

  it('does not re-send a set_value whose verification fails', async () => {
    const calls: Call[] = [];
    setSidecarManagerRef(fakeManager([[el(1, 'To', { patterns: ['Value'] })]], calls));
    const snap = await uiSnapshotTool.execute({ kind: 'desktop' }) as string;
    await uiActTool.execute({
      element_id: idOf(snap, 'To'), action: 'set_value', value: 'a@b.c', verify: 'value_equals',
    });
    expect(acts(calls)).toHaveLength(1);
    expect(acts(calls)[0]!.params.value).toBe('a@b.c');
  });

  it('confirms without re-dispatching when a later re-read satisfies it', async () => {
    const calls: Call[] = [];
    // The dialog is still there on the first re-read and gone on the second.
    setSidecarManagerRef(fakeManager([
      [el(1, 'File'), el(2, 'Save changes?')],
      [el(1, 'File'), el(2, 'Save changes?')],
      [el(1, 'File'), el(2, 'Save changes?')],
      [el(1, 'File')],
    ], calls));
    const snap = await uiSnapshotTool.execute({ kind: 'desktop' }) as string;
    const out = await uiActTool.execute({
      element_id: idOf(snap, 'Save changes?'), action: 'click', verify: 'element_gone',
    }) as string;
    expect(out).toContain('Verified:');
    expect(out).toContain('is gone');
    expect(out).not.toContain('NOT VERIFIED');
    expect(acts(calls)).toHaveLength(1);
  });

  it('window_appeared is not satisfied by the window it acted on', async () => {
    const calls: Call[] = [];
    // Nothing changes: the click did nothing. The old check asked only
    // whether a surface was present and so reported success here.
    setSidecarManagerRef(fakeManager([[el(1, 'File'), el(2, 'Open')]], calls));
    const snap = await uiSnapshotTool.execute({ kind: 'desktop' }) as string;
    const out = await uiActTool.execute({
      element_id: idOf(snap, 'Open'), action: 'click', verify: 'window_appeared',
    }) as string;
    expect(out).toContain('NOT VERIFIED');
    expect(out).toContain('unchanged');
  });

  it('window_appeared passes when a dialog actually opens', async () => {
    const calls: Call[] = [];
    setSidecarManagerRef(fakeManager([
      [el(1, 'File'), el(2, 'Open')],
      [el(1, 'File'), el(2, 'Open')],
      [el(1, 'File'), el(2, 'Open'), el(3, 'Choose a file')],
    ], calls));
    const snap = await uiSnapshotTool.execute({ kind: 'desktop' }) as string;
    const out = await uiActTool.execute({
      element_id: idOf(snap, 'Open'), action: 'click', verify: 'window_appeared',
    }) as string;
    expect(out).toContain('Verified:');
    expect(out).toContain('Choose a file');
  });

  it('reports nothing to verify when verify is omitted, with one dispatch', async () => {
    const calls: Call[] = [];
    setSidecarManagerRef(fakeManager([[el(1, 'File'), el(2, 'Send')]], calls));
    const snap = await uiSnapshotTool.execute({ kind: 'desktop' }) as string;
    const out = await uiActTool.execute({ element_id: idOf(snap, 'Send'), action: 'click' }) as string;
    expect(acts(calls)).toHaveLength(1);
    expect(out).not.toContain('NOT VERIFIED');
    expect(out).toContain('Changed:');
    // One pre-act capture and one after-capture for the diff; no ladder.
    expect(captures(calls).length).toBe(3);
  });
});

describe('ui_act postcondition parsing', () => {
  beforeEach(() => resetUiSnapshots());

  const acted = semanticNodeFromUia(el(1, 'To', { patterns: ['Value'] }));

  it('builds every postcondition the tool advertises', () => {
    for (const verb of ['window_appeared', 'element_gone', 'element_present', 'focus_moved', 'title_changed']) {
      const pc = parsePostcondition(verb, acted, 'Untitled', undefined);
      expect(typeof pc).toBe('object');
      expect((pc as { kind: string }).kind).toBe(verb);
    }
    const ve = parsePostcondition('value_equals', acted, 'Untitled', 'a@b.c');
    expect(ve).toEqual({ kind: 'value_equals', ref: acted.ref, value: 'a@b.c' });
  });

  it('refuses an unknown verify instead of acting unverified', async () => {
    const calls: Call[] = [];
    setSidecarManagerRef(fakeManager([[el(1, 'Send')]], calls));
    const snap = await uiSnapshotTool.execute({ kind: 'desktop' }) as string;
    const out = await uiActTool.execute({
      element_id: idOf(snap, 'Send'), action: 'click', verify: 'it_worked',
    }) as string;
    expect(out).toContain('unknown verify');
    expect(out).toContain('nothing was done');
    expect(acts(calls)).toHaveLength(0);
  });

  it('refuses value_equals with no value, before dispatching', async () => {
    const calls: Call[] = [];
    setSidecarManagerRef(fakeManager([[el(1, 'To', { patterns: ['Value'] })]], calls));
    const snap = await uiSnapshotTool.execute({ kind: 'desktop' }) as string;
    const out = await uiActTool.execute({
      element_id: idOf(snap, 'To'), action: 'click', verify: 'value_equals',
    }) as string;
    expect(out).toContain('needs the value parameter');
    expect(acts(calls)).toHaveLength(0);
  });
});

describe('advertised actions exist', () => {
  beforeEach(() => resetUiSnapshots());

  it('does not offer get_text, which the sidecar does not implement', async () => {
    const calls: Call[] = [];
    setSidecarManagerRef(fakeManager([[el(1, 'Body', { patterns: ['Text', 'Value'] })]], calls));
    const snap = await uiSnapshotTool.execute({ kind: 'desktop' }) as string;
    expect(snap).not.toContain('get_text');
    expect(uiActTool.description).not.toContain('get_text');
    // uia_actions_windows.go implements these; the snapshot may advertise
    // only those.
    const implemented = new Set(['click', 'double_click', 'right_click', 'invoke', 'toggle',
      'set_value', 'get_value', 'expand', 'collapse', 'select', 'scroll_into_view', 'focus']);
    const advertised = snap.match(/\{([a-z_/]+)\}/g) ?? [];
    expect(advertised.length).toBeGreaterThan(0);
    for (const group of advertised) {
      for (const a of group.slice(1, -1).split('/')) expect(implemented.has(a)).toBe(true);
    }
  });
});

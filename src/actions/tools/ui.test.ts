import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { uiSnapshotTool, uiActTool, resetUiSnapshots } from './ui.ts';
import { getSidecarManager, setSidecarManagerRef } from './sidecar-route.ts';
import type { SidecarManager } from '../../sidecar/manager.ts';
import type { UiaSemanticElement } from '../../structural/types.ts';

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
 * A sidecar that answers get_window_tree from a queue of trees, so a test
 * can make the element ids move between the model's snapshot and the
 * capture ui_act takes before acting.
 */
function fakeManager(trees: UiaSemanticElement[][], calls: Call[]): SidecarManager {
  const queue = [...trees];
  return {
    listSidecars: () => [{
      id: 'sc1', name: 'desktop-pc', connected: true,
      capabilities: ['desktop', 'browser'], unavailable_capabilities: [],
    }],
    dispatchRPC: async (_id: string, method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === 'get_window_tree') {
        const elements = queue.length > 1 ? queue.shift()! : queue[0]!;
        return { window_title: 'Untitled - Notepad', pid: 42, elements };
      }
      if (method === 'browser_ax_snapshot') {
        return { url: 'https://x.test', title: 'x', elements: [] };
      }
      return { success: true };
    },
  } as unknown as SidecarManager;
}

describe('ui_act resolves the model\'s [id] by durable ref, on the window it was taken from', () => {
  beforeEach(() => resetUiSnapshots());

  it('refuses to act when no ui_snapshot has been taken', async () => {
    const calls: Call[] = [];
    setSidecarManagerRef(fakeManager([[el(1, 'Send')]], calls));
    const out = await uiActTool.execute({ element_id: 1 }) as string;
    expect(out).toContain('no ui_snapshot');
    expect(calls.some((c) => c.method === 'click_element')).toBe(false);
  });

  it('acts on the live id after the tree re-numbered, and on the snapshot\'s pid', async () => {
    const calls: Call[] = [];
    // Snapshot: Send is [2]. Before acting, a banner appeared so Send is [3].
    setSidecarManagerRef(fakeManager([
      [el(1, 'File'), el(2, 'Send')],
      [el(1, 'File'), el(2, 'Update available'), el(3, 'Send')],
    ], calls));
    const snap = await uiSnapshotTool.execute({ kind: 'desktop', pid: 42 }) as string;
    expect(snap).toContain('[2] Button "Send"');

    const out = await uiActTool.execute({ element_id: 2, action: 'click' }) as string;
    const click = calls.find((c) => c.method === 'click_element');
    expect(click?.params.element_id).toBe(3);
    expect(out).toContain('Acted: click on [2] Button "Send"');
    const captures = calls.filter((c) => c.method === 'get_window_tree');
    expect(captures.length).toBeGreaterThanOrEqual(2);
    for (const c of captures) expect(c.params.pid).toBe(42);
  });

  it('does nothing when the element is gone from the surface', async () => {
    const calls: Call[] = [];
    setSidecarManagerRef(fakeManager([
      [el(1, 'File'), el(2, 'Send')],
      [el(1, 'File'), el(2, 'Discard')],
    ], calls));
    await uiSnapshotTool.execute({ kind: 'desktop' });
    const out = await uiActTool.execute({ element_id: 2 }) as string;
    expect(out).toContain('no longer on the surface');
    expect(out).toContain('nothing was done');
    expect(calls.some((c) => c.method === 'click_element')).toBe(false);
  });

  it('rejects an [id] that is not in the last snapshot', async () => {
    const calls: Call[] = [];
    setSidecarManagerRef(fakeManager([[el(1, 'File')]], calls));
    await uiSnapshotTool.execute({ kind: 'desktop' });
    const out = await uiActTool.execute({ element_id: 99 }) as string;
    expect(out).toContain('not in the most recent ui_snapshot');
    expect(calls.some((c) => c.method === 'click_element')).toBe(false);
  });

  it('never turns a read-only browser action into a click', async () => {
    const calls: Call[] = [];
    setSidecarManagerRef(fakeManager([[]], calls));
    const out = await uiActTool.execute({ kind: 'browser', element_id: 7, action: 'get_value' }) as string;
    expect(out).toContain('not available for kind="browser"');
    expect(calls.some((c) => c.method.startsWith('browser_ax_'))).toBe(false);
  });
});

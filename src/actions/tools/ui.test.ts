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

describe('ui_act\'s gate intent reduces the page text it quotes (#631)', () => {
  beforeEach(() => resetUiSnapshots());

  /**
   * The gate for the sole element of a one-element snapshot.
   *
   * `idOf` is no use here: these names carry newlines on purpose, so the line
   * that prints one is not the line that carries its `[id]`. The id is read
   * off the first `[n]` the snapshot prints instead.
   */
  async function gateFor(name: string, action: unknown = 'click') {
    const calls: Call[] = [];
    setSidecarManagerRef(fakeManager([[el(1, name)]], calls));
    const snap = await uiSnapshotTool.execute({ kind: 'desktop' }) as string;
    const id = Number(snap.match(/\[(\d+)\] Button/)![1]);
    const gate = uiActTool.authorityGate!({ element_id: id, action });
    if (!gate) throw new Error('ui_act returned no gate for a click');
    return gate;
  }

  /** The sentence must still END with its warning, whatever the value was. */
  const CLOSES = 'UI labels do not prove what an action will do.';

  it('caps an element name so it cannot run on past the sentence', async () => {
    // A page can name an element anything. Unreduced, this pushed the warning
    // that closes the sentence off the end of the card a person reads: the same
    // input measured 5179 characters before the fix.
    const long = `Save${'x'.repeat(5000)}`;
    const gate = await gateFor(long);
    expect(gate.intent!.length).toBeLessThan(400);
    expect(gate.intent).not.toContain('x'.repeat(200));
    expect(gate.intent!.endsWith(CLOSES)).toBe(true);
  });

  it('drops the control characters forCard leaves behind', async () => {
    // `forCard` strips the bidi and zero-width class and collapses `\s`, which
    // leaves raw C0 and DEL. Escaped rather than dropped they would also expand
    // six-fold (`\u001b` is six characters for one), so the 80-char cap would
    // not bound what a reader sees. Dropped, the cap means what it says.
    const gate = await gateFor(`Save${'\u001b'.repeat(500)}\u0001\u007f`);
    expect(gate.intent!.length).toBeLessThan(300);
    expect(gate.intent).toContain('"Save"');
    expect(gate.intent).not.toContain('\u001b');
    expect(gate.intent).not.toContain('\\u001b');
    // Quoted on both sides, so nothing can forge the end of the value.
    expect(gate.intent).toMatch(/element \[\d+\] ".*" on /);
    expect(gate.intent!.endsWith(CLOSES)).toBe(true);
  });

  it('keeps a verb when the action reduces to nothing', async () => {
    // A single zero-width character is TRUTHY, so a `|| 'click'` applied before
    // the reduction would not fire and the sentence would lose its verb.
    const gate = await gateFor('Send', '​');
    expect(gate.intent!.startsWith('Review click on ')).toBe(true);
  });

  it('drops the bidi overrides that reorder a card, and collapses the layout', async () => {
    // A right-to-left override survives a length cap untouched and renders the
    // rest of the sentence in another order.
    const hostile = 'Delete\n\n\n  all‮messages';
    const gate = await gateFor(hostile);
    expect(gate.intent).not.toContain('‮');
    expect(gate.intent).toContain('Delete all');
    // No ESCAPED newline either: the whitespace is collapsed before quoting,
    // so the card shows one line rather than a `\n`-littered one. (Asserting
    // the raw character would be tautological here -- JSON.stringify escapes
    // it regardless -- so the real assertion is on the escape.)
    expect(gate.intent).not.toContain('\\n');
  });

  it('caps the target, which is the model\'s own string when no sidecar matches', async () => {
    const calls: Call[] = [];
    setSidecarManagerRef(fakeManager([[el(1, 'Send')]], calls));
    const snap = await uiSnapshotTool.execute({ kind: 'desktop', target: `pc${'y'.repeat(5000)}` }) as string;
    const gate = uiActTool.authorityGate!({ element_id: idOf(snap, 'Send'), action: 'click' });
    expect(gate!.intent!.length).toBeLessThan(400);
    expect(gate!.intent).not.toContain('y'.repeat(200));
    // The target is NOT quoted, so here a raw newline really would scroll the
    // verb out of view, and the collapse is the only thing stopping it.
    expect(gate!.intent).not.toContain('\n');
    expect(gate!.intent!.endsWith(CLOSES)).toBe(true);
  });

  it('reduces the action too, which the enum does not yet constrain here', async () => {
    // `validateParameters` enforces the enum inside `execute`, i.e. AFTER the
    // card is built and shown, so at gate time `action` is just a string the
    // model wrote. It leads the sentence, so an unreduced one pushed the
    // closing warning off exactly as the element name did.
    const gate = await gateFor('Send', `click${'z'.repeat(5000)}`);
    expect(gate.intent!.length).toBeLessThan(400);
    expect(gate.intent).not.toContain('z'.repeat(200));
    expect(gate.intent!.endsWith(CLOSES)).toBe(true);
  });

  // Both classes have to reach the fallback: `forCard` removes the first, and
  // this module's own CARD_CONTROLS the second. Before that strip an all-C0
  // target was still non-empty, no fallback fired, and the card read "on .".
  for (const [label, target] of [
    ['zero-width', '​​'],
    ['C0 control', '\u0001\u0002'],
  ] as const) it(`names the machine when a ${label} target reduces to nothing`, async () => {
    const calls: Call[] = [];
    setSidecarManagerRef(fakeManager([[el(1, 'Send')]], calls));
    const snap = await uiSnapshotTool.execute({ kind: 'desktop', target }) as string;
    const gate = uiActTool.authorityGate!({ element_id: idOf(snap, 'Send'), action: 'click' });
    expect(`${label}:${gate!.intent!.includes('on (unnamed machine).')}`).toBe(`${label}:true`);
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

/**
 * #640, the second half: `ui_act` compared the page's own url+title where every
 * other path compares the loaderId.
 *
 * `history.pushState` rewrites `location.href` and `document.title` while the
 * document holds, which is how every SPA navigates, so an ordinary click on
 * Gmail or Linear -- or the cell-to-cell id reuse `webapp-templates/gsheets.yaml`
 * tells the model to do -- was refused for a surface that had not changed. #603
 * named this and deliberately left it, because `browser_ax_snapshot`'s reply
 * carried no document identity to compare instead. It carries `loader_id` now.
 *
 * The four tests below are the four cases that have to stay apart: a moved URL
 * on a held document (act), a moved document (refuse), a sidecar too old to say
 * (refuse, as before), and a desktop surface, which has no document at all and
 * keeps url+title as its only identity (refuse).
 */
describe('ui_act compares the document, not the page\'s own url and title (#640)', () => {
  beforeEach(() => resetUiSnapshots());

  /** A browser sidecar whose AX snapshot replies come from a queue. */
  function browserManager(replies: Array<Record<string, unknown>>, calls: Call[]): SidecarManager {
    const queue = [...replies];
    return {
      listSidecars: () => [{ id: 'sc1', name: 'chrome-box', connected: true,
        capabilities: ['browser'], unavailable_capabilities: [] }],
      dispatchRPC: async (_i: string, method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        if (method === 'browser_ax_snapshot') return queue.length > 1 ? queue.shift()! : queue[0]!;
        return { success: true };
      },
    } as unknown as SidecarManager;
  }

  const send = [{ ax_id: 'a', backend_node_id: 7, role: 'button', name: 'Send', interactive: true, sig: 's7' }];
  const clicks = (calls: Call[]) => calls.filter((c) => c.method === 'browser_ax_click');

  it('acts after a pushState moved the url AND the title, because the document held', async () => {
    const calls: Call[] = [];
    setSidecarManagerRef(browserManager([
      { url: 'https://mail.test/u/0/#inbox', title: 'Inbox (3)', loader_id: 'LOADER-1', elements: send },
      // Same document (loader_id unchanged), both page-authored fields moved.
      { url: 'https://mail.test/u/0/#inbox/thread-9', title: 'Re: invoice', loader_id: 'LOADER-1', elements: send },
    ], calls));
    const snap = await uiSnapshotTool.execute({ kind: 'browser' }) as string;
    const out = await uiActTool.execute({ element_id: idOf(snap, 'Send'), action: 'click' }) as string;
    expect(out).not.toContain('the UI surface changed since review');
    expect(clicks(calls)).toHaveLength(1);
    expect(clicks(calls)[0]!.params.backend_node_id).toBe(7);
  });

  it('still refuses when the document itself was replaced, even with the url and title unchanged', async () => {
    // The direction that must not be lost, and the one url+title could not
    // see on its own: a same-url re-navigation commits a new document, every
    // id from the old one is meaningless, and the two page-authored fields
    // both compare equal.
    const calls: Call[] = [];
    setSidecarManagerRef(browserManager([
      { url: 'https://mail.test/u/0/#inbox', title: 'Inbox (3)', loader_id: 'LOADER-1', elements: send },
      { url: 'https://mail.test/u/0/#inbox', title: 'Inbox (3)', loader_id: 'LOADER-2', elements: send },
    ], calls));
    const snap = await uiSnapshotTool.execute({ kind: 'browser' }) as string;
    const out = await uiActTool.execute({ element_id: idOf(snap, 'Send'), action: 'click' }) as string;
    expect(out).toContain('the UI surface changed since review');
    expect(out).toContain('nothing was done');
    expect(clicks(calls)).toHaveLength(0);
  });

  for (const [label, absent] of [
    ['an older sidecar that sends none', {}],
    ['an empty one, which must not compare equal to another empty one', { loader_id: '' }],
    ['a non-string one', { loader_id: 42 }],
    ['an over-long one', { loader_id: 'x'.repeat(129) }],
  ] as const) {
    it(`falls back to url+title for ${label}`, async () => {
      // Degrading to the STRICTER comparison, so a missing or unusable identity
      // costs a retry and never a click on a document nothing vouched for.
      const calls: Call[] = [];
      setSidecarManagerRef(browserManager([
        { url: 'https://mail.test/a', title: 'A', ...absent, elements: send },
        { url: 'https://mail.test/b', title: 'B', ...absent, elements: send },
      ], calls));
      const snap = await uiSnapshotTool.execute({ kind: 'browser' }) as string;
      const out = await uiActTool.execute({ element_id: idOf(snap, 'Send'), action: 'click' }) as string;
      expect(out).toContain('the UI surface changed since review');
      expect(clicks(calls)).toHaveLength(0);
    });
  }

  it('a desktop surface keeps url+title as its identity, having no document', async () => {
    // Not a regression to tolerate -- it is the right check for a window. The
    // loaderId term must not reach this path, and `surfaceFromUia` sets none.
    const calls: Call[] = [];
    setSidecarManagerRef(fakeManager(
      [[el(1, 'File'), el(2, 'Send')], [el(1, 'File'), el(2, 'Send')]],
      calls,
      ['Untitled - Notepad', 'draft.txt - Notepad'],
    ));
    const snap = await uiSnapshotTool.execute({ kind: 'desktop' }) as string;
    const out = await uiActTool.execute({ element_id: idOf(snap, 'Send'), action: 'click' }) as string;
    expect(out).toContain('the UI surface changed since review');
    expect(acts(calls)).toHaveLength(0);
  });

  it('a read still works while the surface is moving, since it dispatches nothing', async () => {
    // `get_value` is in READ_ONLY_ACTIONS, so the surface check is skipped by
    // design. Pinned so the predicate change cannot have started refusing reads.
    const calls: Call[] = [];
    setSidecarManagerRef(browserManager([
      { url: 'https://mail.test/a', title: 'A', loader_id: 'LOADER-1',
        elements: [{ ax_id: 'a', backend_node_id: 7, role: 'textbox', name: 'Subject', interactive: true, sig: 's7' }] },
      { url: 'https://mail.test/b', title: 'B', loader_id: 'LOADER-2',
        elements: [{ ax_id: 'a', backend_node_id: 7, role: 'textbox', name: 'Subject', interactive: true, sig: 's7' }] },
    ], calls));
    const snap = await uiSnapshotTool.execute({ kind: 'browser' }) as string;
    const out = await uiActTool.execute({ element_id: idOf(snap, 'Subject'), action: 'get_value' }) as string;
    expect(out).not.toContain('the UI surface changed since review');
  });
});

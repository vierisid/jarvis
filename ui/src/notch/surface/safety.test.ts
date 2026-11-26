import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import type { NotchFromPage, NotchLine } from '../../../../src/notch/protocol.ts';
import type { NotchSurface } from './index.ts';

// Point 7 of the notch review, 26 November 2026: the small things that made
// the page unsafe before it becomes a renderer. A message it cannot read must
// not leave it dead. See docs/notch/fixes/07-page-renderer.md.
let createNotchSurface: (typeof import('./index.ts'))['createNotchSurface'];
let root: HTMLElement, surface: NotchSurface, sent: NotchFromPage[], dropped: string[];

const wait = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));
const $ = <T extends Element = HTMLElement>(selector: string): T | null => root.querySelector<T>(selector);
const body = (): string | undefined => $('.nin')?.dataset.body;
const said = (): string => ($('.say')?.textContent ?? '').replace(/\s+/g, ' ').trim();
const show = (line: NotchLine): void => surface.receive({ type: 'show', line });
const acts = (): string[] => sent.map((m) => (m.type === 'answer' ? `${m.id}:${m.act}` : m.type));

/** A page that has heard nothing from the brain yet. */
function fresh(): void {
  surface.destroy();
  root.replaceChildren();
  sent = [];
  dropped = [];
  surface = createNotchSurface(root, (message) => sent.push(message), { reducedMotion: true });
  surface.onDropped((what) => dropped.push(what));
}

/** Runs `fn` on a page where a text field cannot be made: a line that is well formed and still cannot be drawn. */
function withNoFields(fn: () => void): void {
  const real = document.createElement;
  const errors = console.error;
  document.createElement = ((tag: string, ...rest: unknown[]) => {
    if (tag === 'input') throw new Error('no field can be made');
    return (real as (...args: unknown[]) => HTMLElement).call(document, tag, ...rest);
  }) as typeof document.createElement;
  console.error = () => {};
  try { fn(); } finally { document.createElement = real; console.error = errors; }
}

/** Runs `fn` on a page where the next sentence cannot be made, once: the drawing fails when it is already on its way. */
function withOneSentenceLost(fn: () => void): void {
  const real = document.createDocumentFragment;
  const errors = console.error;
  let lost = false;
  document.createDocumentFragment = (() => {
    if (!lost) { lost = true; throw new Error('no sentence can be made'); }
    return real.call(document);
  }) as typeof document.createDocumentFragment;
  console.error = () => {};
  try { fn(); } finally { document.createDocumentFragment = real; console.error = errors; }
}

const undrawable: NotchLine = { id: 'q', kind: 'ask', say: [], placeholder: 'Tell me', yes: 'ask', blocks: [] };
const usualPairs = { talk: ['ctrl', 'meta'], yes: ['meta', 'alt'] };

beforeAll(async () => {
  GlobalRegistrator.register();
  ({ createNotchSurface } = await import('./index.ts'));
});
afterAll(() => GlobalRegistrator.unregister());
beforeEach(() => {
  root = document.createElement('div');
  document.body.append(root);
  sent = [];
  dropped = [];
  surface = createNotchSurface(root, (message) => sent.push(message), { reducedMotion: true });
  surface.onDropped((what) => dropped.push(what));
  surface.setPairs(usualPairs);
  surface.receive({ type: 'state', line: null, count: 0 });
});
afterEach(() => {
  surface.destroy();
  root.remove();
});

describe('a message the page cannot read', () => {
  test('when it is the first thing a page hears, the page is not dead: the next one it can read is shown', () => {
    fresh();
    // A sheet with no blocks, told to a page that came up in the middle of it.
    surface.receive({ type: 'state', count: 1, line: { id: 'bad', kind: 'sheet', say: ['Approve?'], yes: 'approve' } } as never);
    expect(dropped.length).toBe(1);
    expect(surface.outlines(0)).toEqual([]);
    // The brain is asked again, and this time says something that can be drawn.
    surface.receive({ type: 'state', count: 1, line: { id: 'good', kind: 'offer', say: ['Reply to ', { em: 'Marco' }, '?'], yes: 'show' } });
    expect(said()).toContain('Reply to Marco?');
    show({ id: 'next', kind: 'say', say: ['Sent.'], ms: 4000 });
    expect(said()).toContain('Sent.');
    surface.key('esc');
    expect(acts()).toEqual(['next:done']);
  });

  test('is dropped whole: nothing of it is on the notch, and it is said what was dropped', () => {
    show({ id: 'o', kind: 'offer', say: ['Reply?'], yes: 'show', fold: 0 });
    const junk: unknown[] = [
      null, 42, { type: 'nothing' },
      { type: 'show', line: { id: 'x', kind: 'sheet', say: ['T'], blocks: [{ kind: 'unknown' }] } },
      { type: 'state', count: 9, face: 'closed', line: { id: 'y', kind: 'sheet', say: ['T'] } },
      { type: 'update', id: 'o', say: [{ nope: 1 }] },
    ];
    for (const message of junk) surface.receive(message as never);
    expect(dropped.length).toBe(junk.length);
    expect(dropped[3]).toContain('show');
    expect(dropped[3]).toContain('sheet');
    expect(said()).toContain('Reply?');
    expect($('.nin')?.dataset.mood).not.toBe('closed');
    $<HTMLElement>('.hint .key')!.click();
    expect(acts()).toEqual(['o:yes']);
  });

  test('in place of a result does not keep that result up for ever: it still leaves on time, and says so', async () => {
    show({ id: 'r', kind: 'say', say: ['Sent.'], ms: 150 });
    // A line whose sentence holds something that is not a part of one.
    surface.receive({ type: 'show', line: { id: 'b', kind: 'say', say: [{ nope: 1 }], ms: 4000 } } as never);
    expect(said()).toContain('Sent.');
    await wait(450);
    expect(acts()).toEqual(['r:done']);
    expect(body()).toBe('rest');
  });
});

describe('a line that is well formed and still cannot be drawn', () => {
  test('told to a page that comes up, leaves the page alive and at rest', () => {
    fresh();
    withNoFields(() => surface.receive({ type: 'state', count: 0, line: undrawable }));
    expect(body()).toBe('rest');
    show({ id: 'next', kind: 'offer', say: ['Reply?'], yes: 'show' });
    expect(said()).toContain('Reply?');
    $<HTMLElement>('.hint .key')!.click();
    expect(acts()).toEqual(['next:yes']);
  });

  test('in place of a result, the result still leaves when its time is up', async () => {
    show({ id: 'r', kind: 'say', say: ['Sent.'], ms: 300 });
    await wait(100);
    withNoFields(() => show(undrawable));
    expect(said()).toContain('Sent.');
    await wait(500);
    expect(acts()).toEqual(['r:done']);
    expect(body()).toBe('rest');
  });

  test('when the drawing fails half way, the result that stays is whole again and still leaves', async () => {
    show({ id: 'r', kind: 'say', say: ['Sent.'], ms: 300 });
    await wait(100);
    withOneSentenceLost(() => show({ id: 'n', kind: 'say', say: ['Next.'], ms: 4000 }));
    expect(said()).toContain('Sent.');
    await wait(500);
    expect(acts()).toEqual(['r:done']);
    expect(body()).toBe('rest');
  });

  test('a field that is being typed in is not emptied by a line that could not take its place', () => {
    show({ id: 'a', kind: 'ask', say: [], placeholder: 'Tell me', yes: 'ask', blocks: [] });
    const field = $<HTMLInputElement>('input.ask')!;
    field.value = 'half a sent';
    withNoFields(() => show(undrawable));
    expect($<HTMLInputElement>('input.ask')).toBe(field);
    expect(field.value).toBe('half a sent');
  });

  test('in place of an offer, the offer still folds', async () => {
    show({ id: 'o', kind: 'offer', say: ['Reply?'], yes: 'show', fold: 200 });
    withNoFields(() => show(undrawable));
    expect(said()).toContain('Reply?');
    await wait(600);
    expect(acts()).toEqual(['o:fold']);
    expect(body()).toBe('rest');
  });
});

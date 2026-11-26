import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { NOTCH_FUSE_SEEN_MS } from '../../../../src/notch/protocol.ts';
import type { NotchFromPage, NotchLine } from '../../../../src/notch/protocol.ts';
import type { NotchSurface } from './index.ts';
import { createTestClock, type NotchTestClock } from './test-clock.ts';

// Point 7 of the notch review, 26 November 2026: the three small things that
// made the page unsafe before it becomes a renderer. A message it cannot read
// must not leave it dead; a line drawn again must not start its time again,
// nor forget that it was answered. See docs/notch/fixes/07-page-renderer.md.
//
// Time here is the test's own (./test-clock.ts): it moves only when told to.
let createNotchSurface: (typeof import('./index.ts'))['createNotchSurface'];
let root: HTMLElement, surface: NotchSurface, sent: NotchFromPage[], dropped: string[], clock: NotchTestClock;

const $ = <T extends Element = HTMLElement>(selector: string): T | null => root.querySelector<T>(selector);
const body = (): string | undefined => $('.nin')?.dataset.body;
const said = (): string => ($('.say')?.textContent ?? '').replace(/\s+/g, ' ').trim();
const show = (line: NotchLine): void => surface.receive({ type: 'show', line });
const state = (line: NotchLine | null, count = 0): void => surface.receive({ type: 'state', line, count });
const acts = (): string[] => sent.map((m) => (m.type === 'answer' ? `${m.id}:${m.act}` : m.type));
const fusing = (): boolean => $('.wrap')?.classList.contains('fusing') === true;
const answered = (): boolean => $('.nin')?.classList.contains('answered') === true;

function make(): void {
  sent = [];
  dropped = [];
  clock = createTestClock();
  surface = createNotchSurface(root, (message) => sent.push(message), { reducedMotion: true, clock });
  surface.onDropped((what) => dropped.push(what));
}

/** A page that has heard nothing from the brain yet. */
function fresh(): void {
  surface.destroy();
  root.replaceChildren();
  make();
}

/** Runs `fn` with console.error quiet, and `undo` called after it whatever happens. */
function broken(undo: () => void, fn: () => void): void {
  const errors = console.error;
  console.error = () => {};
  try { fn(); } finally { undo(); console.error = errors; }
}

/** Runs `fn` on a page where a text field cannot be made: a line that is well formed and still cannot be drawn. */
function withNoFields(fn: () => void): void {
  const real = document.createElement;
  document.createElement = ((tag: string, ...rest: unknown[]) => {
    if (tag === 'input') throw new Error('no field can be made');
    return (real as (...args: unknown[]) => HTMLElement).call(document, tag, ...rest);
  }) as typeof document.createElement;
  broken(() => { document.createElement = real; }, fn);
}

/** Runs `fn` on a page where the next sentence cannot be made, once: the drawing fails when it is already on its way. */
function withOneSentenceLost(fn: () => void): void {
  const real = document.createDocumentFragment;
  let lost = false;
  document.createDocumentFragment = (() => {
    if (!lost) { lost = true; throw new Error('no sentence can be made'); }
    return real.call(document);
  }) as typeof document.createDocumentFragment;
  broken(() => { document.createDocumentFragment = real; }, fn);
}

/** Runs `fn` on a page where the small words after a line's keys cannot be put, once: the drawing fails when the line is already on screen. */
function withNoStepNote(fn: () => void): void {
  const hint = $('.hint')!;
  let lost = false;
  (hint as { append: unknown }).append = (...nodes: Node[]) => {
    if (!lost) { lost = true; throw new Error('nothing can be added'); }
    Element.prototype.append.call(hint, ...nodes);
  };
  broken(() => { delete (hint as { append?: unknown }).append; }, fn);
}

const undrawable: NotchLine = { id: 'q', kind: 'ask', say: [], placeholder: 'Tell me', yes: 'ask', blocks: [] };
const otherPairs = { talk: ['ctrl', 'alt'], yes: ['meta', 'shift'] };
const usualPairs = { talk: ['ctrl', 'meta'], yes: ['meta', 'alt'] };
/** A sheet with no blocks: nothing that can be drawn. */
const unreadable = { id: 'bad', kind: 'sheet', say: ['Approve?'], yes: 'approve' } as unknown as NotchLine;

beforeAll(async () => {
  GlobalRegistrator.register();
  ({ createNotchSurface } = await import('./index.ts'));
});
afterAll(() => GlobalRegistrator.unregister());
beforeEach(() => {
  root = document.createElement('div');
  document.body.append(root);
  make();
  surface.setPairs(usualPairs);
  state(null);
});
afterEach(() => {
  surface.destroy();
  root.remove();
});

describe('a message the page cannot read', () => {
  test('a line that cannot be read, told to a page that comes up, leaves it resting with the rest of what it was told', () => {
    fresh();
    state(unreadable, 3);
    expect(dropped).toEqual(['state sheet']);
    // It is on screen, at rest, with the count: not dead, and not waiting for the brain to say it all again.
    expect(surface.outlines(0).length).toBeGreaterThan(0);
    expect(body()).toBe('rest');
    expect($('.badge')?.textContent).toBe('3');
    show({ id: 'next', kind: 'say', say: ['Sent.'], ms: 4000 });
    expect(said()).toContain('Sent.');
    surface.key('esc');
    expect(acts()).toEqual(['next:done']);
  });

  test('told to a page that shows a line, such a state takes nothing off the notch', () => {
    show({ id: 'o', kind: 'offer', say: ['Reply?'], yes: 'show', fold: 0 });
    state(unreadable, 2);
    expect(dropped).toEqual(['state sheet']);
    expect(said()).toContain('Reply?');
    $<HTMLElement>('.hint .key')!.click();
    expect(acts()).toEqual(['o:yes']);
  });

  test('is dropped whole: nothing of it is on the notch, and it is said what was dropped', () => {
    show({ id: 'o', kind: 'offer', say: ['Reply?'], yes: 'show', fold: 0 });
    const junk: unknown[] = [
      null, 42, {}, { type: 7 },
      { type: 'show', line: { id: 'x', kind: 'sheet', say: ['T'], blocks: [{ kind: 'unknown' }] } },
      { type: 'update', id: 'o', say: [{ nope: 1 }] },
      { type: 'face' },
    ];
    for (const message of junk) surface.receive(message as never);
    expect(dropped).toEqual(['not a message', 'not a message', 'not a message', 'not a message', 'show sheet', 'update', 'face']);
    expect(said()).toContain('Reply?');
    $<HTMLElement>('.hint .key')!.click();
    expect(acts()).toEqual(['o:yes']);
  });

  test('one that is well formed and of a kind the page has never heard of is passed over without a word', () => {
    show({ id: 'o', kind: 'offer', say: ['Reply?'], yes: 'show', fold: 0 });
    // What a newer brain may say to this page.
    for (const message of [{ type: 'patch', seq: 4, line: null }, { type: 'effect', do: [] }, { type: 'face', mood: 'furious' }]) surface.receive(message as never);
    expect(dropped).toEqual([]);
    expect(said()).toContain('Reply?');
    expect($('.nin')?.dataset.mood).not.toBe('furious');
  });

  test('in place of a result does not keep that result up for ever: it still leaves on time, and says so', () => {
    show({ id: 'r', kind: 'say', say: ['Sent.'], ms: 3000 });
    clock.advance(1000);
    // A line whose sentence holds something that is not a part of one.
    surface.receive({ type: 'show', line: { id: 'b', kind: 'say', say: [{ nope: 1 }], ms: 4000 } } as never);
    expect(said()).toContain('Sent.');
    clock.advance(1999);
    expect(acts()).toEqual([]);
    clock.advance(1);
    expect(acts()).toEqual(['r:done']);
    expect(body()).toBe('rest');
  });
});

describe('a line that is well formed and still cannot be drawn', () => {
  test('told to a page that comes up, leaves the page alive and at rest', () => {
    fresh();
    withNoFields(() => state(undrawable));
    expect(body()).toBe('rest');
    show({ id: 'next', kind: 'offer', say: ['Reply?'], yes: 'show' });
    expect(said()).toContain('Reply?');
    $<HTMLElement>('.hint .key')!.click();
    expect(acts()).toEqual(['next:yes']);
  });

  test('in place of a result, the result still leaves when its time is up', () => {
    show({ id: 'r', kind: 'say', say: ['Sent.'], ms: 3000 });
    clock.advance(1000);
    withNoFields(() => show(undrawable));
    expect(said()).toContain('Sent.');
    clock.advance(1999);
    expect(acts()).toEqual([]);
    clock.advance(1);
    expect(acts()).toEqual(['r:done']);
    expect(body()).toBe('rest');
  });

  test('when the drawing fails half way, the result that stays is whole again and leaves when its time is up, not later', () => {
    show({ id: 'r', kind: 'say', say: ['Sent.'], ms: 3000 });
    clock.advance(1000);
    withOneSentenceLost(() => show({ id: 'n', kind: 'say', say: ['Next.'], ms: 4000 }));
    expect(said()).toContain('Sent.');
    clock.advance(1999);
    expect(acts()).toEqual([]);
    clock.advance(1);
    expect(acts()).toEqual(['r:done']);
    expect(body()).toBe('rest');
  });

  test('when the drawing fails after the line was put on screen, the screen shows the line the keys answer for', () => {
    show({ id: 'a', kind: 'offer', say: ['Send the note to Marco?'], yes: 'send', fold: 0 });
    withNoStepNote(() => show({ id: 'b', kind: 'offer', say: ['Delete the folder?'], yes: 'delete', fold: 0, step: 'step 2/3' }));
    // Not the line that failed on screen, with a yes that would be taken for the other.
    expect(said()).toContain('Send the note to Marco?');
    expect(said()).not.toContain('Delete');
    $<HTMLElement>('.hint .key')!.click();
    expect(acts()).toEqual(['a:yes']);
  });

  test('a field that is being typed in is not emptied by a line that could not take its place', () => {
    show({ id: 'a', kind: 'ask', say: [], placeholder: 'Tell me', yes: 'ask', blocks: [] });
    const field = $<HTMLInputElement>('input.ask')!;
    field.value = 'half a sent';
    withNoFields(() => show(undrawable));
    expect($<HTMLInputElement>('input.ask')).toBe(field);
    expect(field.value).toBe('half a sent');
  });

  test('in place of an offer, the offer still folds', () => {
    show({ id: 'o', kind: 'offer', say: ['Reply?'], yes: 'show', fold: 2000 });
    withNoFields(() => show(undrawable));
    expect(said()).toContain('Reply?');
    clock.advance(10000);
    expect(acts()).toEqual(['o:fold']);
    expect(body()).toBe('rest');
  });
});

describe('a line that is drawn again in the middle of its time', () => {
  test('a fuse goes on from where it was when the keys of the machine change: it does not start again', () => {
    show({ id: 'f', kind: 'send', say: ['Sending to Marco'], ms: 4000 });
    clock.advance(2500);
    surface.setPairs(otherPairs);
    expect(fusing()).toBe(true);
    expect($('.wrap')?.style.getPropertyValue('--fuse-from')).toBe('-2500ms');
    clock.advance(1499);
    expect(acts()).toEqual([]);
    clock.advance(1);
    expect(acts()).toEqual(['f:done']);
  });

  test('a result is shown for what was left of its time, not all of it again', () => {
    show({ id: 'r', kind: 'say', say: ['Sent.'], ms: 4000 });
    clock.advance(2500);
    surface.setPairs(otherPairs);
    expect(said()).toContain('Sent.');
    clock.advance(1499);
    expect(acts()).toEqual([]);
    clock.advance(1);
    expect(acts()).toEqual(['r:done']);
  });

  test('a line that is shown anew has all of its time, whatever the one before it had left', () => {
    show({ id: 'f', kind: 'send', say: ['Sending'], ms: 4000 });
    clock.advance(3000);
    show({ id: 'f', kind: 'send', say: ['Sending'], ms: 4000 });
    clock.advance(3999);
    expect(acts()).toEqual([]);
    clock.advance(1);
    expect(acts()).toEqual(['f:done']);
  });
});

describe('a page that comes up in the middle of a line that runs out', () => {
  test('burns what the brain says is left of a fuse, and then says it ran out', () => {
    fresh();
    state({ id: 'f', kind: 'send', say: ['Sending'], ms: 60000, left: 2500 });
    expect(fusing()).toBe(true);
    // The fuse is drawn as far burnt as it is: 57.5 of its 60 seconds are behind it.
    expect($('.wrap')?.style.getPropertyValue('--fuse')).toBe('60000ms');
    expect($('.wrap')?.style.getPropertyValue('--fuse-from')).toBe('-57500ms');
    clock.advance(2499);
    expect(acts()).toEqual([]);
    clock.advance(1);
    expect(acts()).toEqual(['f:done']);
  });

  test('with as much left as a person needs to read it and press Esc, it vouches for the fuse; with a millisecond less it does not', () => {
    fresh();
    state({ id: 'f', kind: 'send', say: ['Sending'], ms: 4000, left: NOTCH_FUSE_SEEN_MS });
    expect(fusing()).toBe(true);
    clock.advance(NOTCH_FUSE_SEEN_MS);
    expect(acts()).toEqual(['f:done']);

    fresh();
    // The desktop app was gone for most of the fuse: the notch was not on screen while it burnt.
    state({ id: 'g', kind: 'send', say: ['Sending'], ms: 4000, left: NOTCH_FUSE_SEEN_MS - 1 });
    expect(said()).toContain('Sending');
    expect(fusing()).toBe(false);
    clock.advance(60000);
    expect(acts()).toEqual([]);
    // Esc still takes it back.
    surface.key('esc');
    expect(acts()).toEqual(['g:undo']);
  });

  test('a fuse with nothing left burns nothing and is not said to have run out', () => {
    fresh();
    state({ id: 'f', kind: 'send', say: ['Sending'], ms: 3000, left: 0 });
    expect(fusing()).toBe(false);
    clock.advance(60000);
    expect(acts()).toEqual([]);
  });

  test('a fuse shorter than that is vouched for only when all of it is left', () => {
    fresh();
    state({ id: 'f', kind: 'send', say: ['Sending'], ms: 1500, left: 1500 });
    clock.advance(1500);
    expect(acts()).toEqual(['f:done']);
    fresh();
    state({ id: 'g', kind: 'send', say: ['Sending'], ms: 1500, left: 1499 });
    clock.advance(60000);
    expect(acts()).toEqual([]);
  });

  test('a fuse shown to a page that is there is always vouched for, however short', () => {
    show({ id: 'f', kind: 'send', say: ['Sending'], ms: 300 });
    clock.advance(300);
    expect(acts()).toEqual(['f:done']);
  });

  test('a result is shown for what is left of it, however little', () => {
    fresh();
    state({ id: 'r', kind: 'say', say: ['Sent.'], ms: 60000, left: 100 });
    expect(said()).toContain('Sent.');
    clock.advance(99);
    expect(acts()).toEqual([]);
    clock.advance(1);
    expect(acts()).toEqual(['r:done']);
    expect(body()).toBe('rest');
  });

  test('more than all of it cannot be left', () => {
    fresh();
    state({ id: 'r', kind: 'say', say: ['Sent.'], ms: 100, left: 60000 });
    clock.advance(100);
    expect(acts()).toEqual(['r:done']);
  });
});

describe('a page that is told again the line it already shows (it said hello again)', () => {
  const fuse: NotchLine = { id: 'f', kind: 'send', say: ['Sending'], ms: 4000 };

  test('a fuse that burns keeps its own count of what is left, whatever the brain counts', () => {
    show(fuse);
    clock.advance(2500);
    state({ ...fuse, left: 3900 });
    clock.advance(1499);
    expect(acts()).toEqual([]);
    clock.advance(1);
    expect(acts()).toEqual(['f:done']);
  });

  test('a fuse that was taken back stays taken back: it is not said to have run out afterwards', () => {
    show(fuse);
    clock.advance(1000);
    surface.key('esc');
    expect(acts()).toEqual(['f:undo']);
    state({ ...fuse, left: 2900 });
    expect(answered()).toBe(true);
    expect(fusing()).toBe(false);
    clock.advance(60000);
    expect(acts()).toEqual(['f:undo']);
  });

  test('a fuse that ran out is not said to have run out a second time', () => {
    show(fuse);
    clock.advance(4000);
    expect(acts()).toEqual(['f:done']);
    state({ ...fuse, left: 2500 });
    clock.advance(60000);
    expect(acts()).toEqual(['f:done']);
  });

  test('a sheet that was answered stays answered: its yes cannot be given twice', () => {
    const sheet: NotchLine = { id: 's', kind: 'sheet', say: ['Send it?'], yes: 'send', stay: true, blocks: [{ kind: 'note', say: ['To Marco.'] }] };
    show(sheet);
    clock.advance(1000);
    surface.key('yes');
    expect(acts()).toEqual(['s:yes']);
    state(sheet);
    expect(answered()).toBe(true);
    clock.advance(1000);
    surface.key('yes');
    $<HTMLElement>('.hint .key')?.click();
    expect(acts()).toEqual(['s:yes']);
  });

  test('a field that is being typed in keeps what is in it', () => {
    const ask: NotchLine = { id: 'a', kind: 'ask', say: [], placeholder: 'Tell me', yes: 'ask', blocks: [] };
    show(ask);
    const field = $<HTMLInputElement>('input.ask')!;
    field.value = 'half a sent';
    state(ask, 2);
    expect($<HTMLInputElement>('input.ask')).toBe(field);
    expect(field.value).toBe('half a sent');
  });

  test('another line than the one it shows is drawn, as before', () => {
    show(fuse);
    state({ id: 'o', kind: 'offer', say: ['Reply?'], yes: 'show' });
    expect(said()).toContain('Reply?');
    state(null);
    expect(body()).toBe('rest');
  });
});

// Point 5, the owner's decision of 26 November 2026: a time picked for a reply is no longer sent
// unseen. The letter is on the notch while its fuse burns. A send line carries it as blocks.
describe('a letter under its fuse', () => {
  const letter: NotchLine = {
    id: 'slot', kind: 'send', say: ['Offering ', { em: 'Tuesday at 10:00' }, ' to Leo…'], ms: 8000,
    blocks: [{ kind: 'paper', to: ['To ', { em: 'Leo Bianchi' }], lines: [['Hi Leo,'], [{ em: 'Tuesday at 10:00' }, ' would suit me.'], ['Sam']] }],
  };
  /** There is no layout here: the sheet is given a height and a length of its own. */
  const sized = (visible: number, total: number): HTMLElement => {
    const el = $('.sheet')!;
    Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => visible });
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => total });
    return el;
  };
  const paper = (): string => ($('.sheet .paper')?.textContent ?? '').replace(/\s+/g, ' ').trim();
  /** What the page said when the fuse ran out: with its word that the letter was seen, or without. */
  const ranOut = (): unknown[] => sent.filter((m) => m.type === 'answer' && m.act === 'done').map((m) => ({ ...m }));
  const VOUCHED = { type: 'answer', id: 'slot', act: 'done', seen: true };
  const BARE = { type: 'answer', id: 'slot', act: 'done' };
  /** The page is told by its window that it is shown, or not. */
  const sight = (state: 'visible' | 'hidden'): void => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
    document.dispatchEvent(new Event('visibilitychange'));
  };
  afterEach(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); });

  test('is on the notch, whole, with the picked time lit, while the fuse burns, and then it is said to have run out', () => {
    show(letter);
    expect(body()).toBe('sheet');
    expect(said()).toContain('Offering Tuesday at 10:00 to Leo');
    expect(paper()).toBe('To Leo BianchiHi Leo,Tuesday at 10:00 would suit me.Sam');
    // Lit, and not a word that can be changed: nothing in the letter is a button.
    expect($('.sheet .going .paper p:not(.to) b')?.textContent).toBe('Tuesday at 10:00');
    expect($('.sheet button')).toBeNull();
    expect(fusing()).toBe(true);
    expect($('.wrap')?.style.getPropertyValue('--fuse')).toBe('8000ms');
    clock.advance(7999);
    expect(acts()).toEqual([]);
    // The letter is still there for as long as it can be taken back.
    expect(paper()).toContain('would suit me.');
    clock.advance(1);
    // It ran out, and the page says with it that the letter was drawn and seen to its end.
    expect(ranOut()).toEqual([VOUCHED]);
  });

  test('a fuse with no letter never carries that word: it is the letter that is vouched for', () => {
    show({ id: 'slot', kind: 'send', say: ['Sending'], ms: 4000 });
    clock.advance(4000);
    expect(ranOut()).toEqual([BARE]);
  });

  test('out of sight at any moment while it burnt, or when it was drawn, the page says it ran out and does not vouch', () => {
    show(letter);
    clock.advance(3000);
    sight('hidden');
    sight('visible');
    clock.advance(5000);
    expect(ranOut()).toEqual([BARE]);

    fresh();
    state(null);
    sight('hidden');
    show(letter);
    sight('visible');
    clock.advance(8000);
    expect(ranOut()).toEqual([BARE]);

    fresh();
    state(null);
    show(letter);
    clock.advance(7999);
    sight('hidden');
    clock.advance(1);
    expect(ranOut()).toEqual([BARE]);
    // In sight again, a letter after it starts clean.
    fresh();
    state(null);
    sight('visible');
    show(letter);
    clock.advance(8000);
    expect(ranOut()).toEqual([VOUCHED]);
  });

  test('it is a question to the window: the notch is not to be out of sight for it, nor for the work that leads into it', () => {
    const asking: boolean[] = [];
    surface.onAsking((now) => asking.push(now));
    show({ id: 'w', kind: 'work', say: ['Pasting'], steps: 0, done: 0 });
    show({ id: 'f', kind: 'send', say: ['Sending'], ms: 4000 });
    expect(asking).toEqual([]);
    show({ id: 'p', kind: 'work', say: ['Putting it in the thread'], steps: 0, done: 0, asks: true });
    expect(asking).toEqual([true]);
    show(letter);
    expect(asking).toEqual([true]);
    surface.key('esc');
    expect(asking).toEqual([true, false]);
  });

  test('Esc at any moment of it is an undo, once, and it is never then said to have run out', () => {
    for (const at of [0, 400, 7999]) {
      fresh();
      state(null);
      show(letter);
      clock.advance(at);
      surface.key('esc');
      expect(acts()).toEqual(['slot:undo']);
      expect(fusing()).toBe(false);
      surface.key('esc');
      clock.advance(20000);
      expect(acts().filter((act) => act.startsWith('slot:'))).toEqual(['slot:undo']);
    }
  });

  test('the yes keys and a click somewhere else on the screen answer nothing: the person goes on working while it burns', () => {
    show(letter);
    clock.advance(1000);
    surface.key('yes');
    surface.pointer(5, 600, true);
    surface.pointer(5, 600, false);
    expect(acts()).toEqual([]);
    expect(fusing()).toBe(true);
    clock.advance(7000);
    expect(acts()).toEqual(['slot:done']);
  });

  test('a letter whose end was never on screen: the page says the fuse ran out, and does not vouch for the letter', () => {
    show(letter);
    sized(300, 900);
    clock.advance(7999);
    surface.key('esc');
    expect(acts()).toEqual(['slot:undo']);

    fresh();
    state(null);
    show(letter);
    sized(300, 900);
    clock.advance(20000);
    expect(ranOut()).toEqual([BARE]);
  });

  test('scrolled to its end before the fuse is out, it was seen', () => {
    show(letter);
    const el = sized(300, 900);
    clock.advance(4000);
    el.scrollTop = 600;
    clock.advance(4000);
    expect(ranOut()).toEqual([VOUCHED]);
  });

  test('told again to the page that shows it (a hello in the middle), it is not drawn again: the fuse goes on, and an undo stays an undo', () => {
    show(letter);
    const drawn = $('.sheet .paper');
    clock.advance(3000);
    state({ ...letter, left: 5000 });
    expect($('.sheet .paper')).toBe(drawn);
    clock.advance(4999);
    expect(acts()).toEqual([]);
    clock.advance(1);
    expect(acts()).toEqual(['slot:done']);

    fresh();
    state(null);
    show(letter);
    surface.key('esc');
    state({ ...letter, left: 7000 });
    clock.advance(20000);
    expect(acts()).toEqual(['slot:undo']);
  });

  test('a page that comes up in the middle shows the letter and burns what is left; with too little left it does not vouch for it', () => {
    fresh();
    state({ ...letter, left: NOTCH_FUSE_SEEN_MS });
    expect(paper()).toContain('would suit me.');
    expect(fusing()).toBe(true);
    clock.advance(NOTCH_FUSE_SEEN_MS);
    expect(ranOut()).toEqual([VOUCHED]);

    fresh();
    state({ ...letter, left: NOTCH_FUSE_SEEN_MS - 1 });
    expect(paper()).toContain('would suit me.');
    expect(fusing()).toBe(false);
    clock.advance(60000);
    expect(acts()).toEqual([]);
    surface.key('esc');
    expect(acts()).toEqual(['slot:undo']);
  });

  test('a letter the page cannot read is no fuse at all: nothing is shown, nothing burns, nothing is said to run out', () => {
    show({ ...letter, blocks: [{ kind: 'scroll', lines: [] }] } as unknown as NotchLine);
    expect(dropped).toEqual(['show send']);
    expect(body()).toBe('rest');
    clock.advance(20000);
    expect(acts().filter((act) => act.startsWith('slot:'))).toEqual([]);
  });

  test('a send with no letter is the line it always was', () => {
    show({ id: 'f', kind: 'send', say: ['Sending'], ms: 4000 });
    expect(body()).toBe('line');
    expect($('.sheet .paper')).toBeNull();
  });
});

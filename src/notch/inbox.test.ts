import { describe, expect, test } from 'bun:test';
import { NotchInbox } from './inbox.ts';
import type { NotchItem, NotchItemClass, NotchItemEnd } from './inbox.ts';
import type { NotchAnswerAct, NotchLine, NotchToPage } from './protocol.ts';
import type { NotchStage } from './stage.ts';
import { NOTCH_MESSAGE_EVENT, NotchSurface } from './surface.ts';
import type { NotchSurfacePort } from './surface.ts';

/** Lets every promise that is ready run. */
const settle = async (): Promise<void> => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

/** A surface with a page that has said hello, and an inbox on it. */
function harness(options: { page?: boolean; busy?: () => boolean; home?: (stage: NotchStage) => Promise<void>; maySpeak?: () => boolean; elsewhere?: () => boolean } = {}) {
  const pushed: NotchToPage[] = [];
  const logs: string[] = [];
  let onEvent: (sidecarId: string, event: { event_type: string; payload: unknown }) => void = () => {};
  const port: NotchSurfacePort = {
    dispatchRPC(_sidecarId, _method, params) {
      pushed.push((params as { message: NotchToPage }).message);
      return Promise.resolve({ pushed: true });
    },
    onEvent(listener) { onEvent = listener; },
    onSidecarDisconnected() {},
  };
  const timers: { fn: () => void; at: number }[] = [];
  let now = 0;
  const clock = {
    setTimeout: (fn: () => void, ms: number) => { const timer = { fn, at: now + ms }; timers.push(timer); return timer; },
    clearTimeout: (handle: unknown) => { const at = timers.indexOf(handle as { fn: () => void; at: number }); if (at >= 0) timers.splice(at, 1); },
  };
  const surface = new NotchSurface(port, (line) => logs.push(line));
  const inbox = new NotchInbox(surface, { clock, log: (line) => logs.push(line), busy: options.busy, home: options.home, maySpeak: options.maySpeak, elsewhere: options.elsewhere });
  const fromPage = (message: unknown): void => onEvent('pc', { event_type: NOTCH_MESSAGE_EVENT, payload: { message } });
  if (options.page !== false) fromPage({ type: 'hello', v: 1 });
  const line = (): NotchLine | null => surface.current().line;
  return {
    surface, inbox, pushed, logs, line, fromPage,
    said: (): string => (line()?.say ?? []).map((part) => (typeof part === 'string' ? part : 'em' in part ? part.em : '')).join(''),
    count: (): number => surface.current().count,
    /** The person does `act` with the line on the notch. */
    async answer(act: NotchAnswerAct, more: Record<string, unknown> = {}): Promise<void> {
      const id = line()?.id;
      if (!id) throw new Error('nothing is on the notch');
      fromPage({ type: 'answer', id, act, ...more });
      await settle();
    },
    async open(): Promise<void> { fromPage({ type: 'open' }); await settle(); },
    async advance(ms: number): Promise<void> {
      now += ms;
      for (const timer of [...timers].filter((t) => t.at <= now)) {
        const at = timers.indexOf(timer);
        if (at >= 0) { timers.splice(at, 1); timer.fn(); }
      }
      await settle();
    },
  };
}

/** An item that offers itself, and remembers what was done with it. */
function item(id: string, cls: NotchItemClass = 'rest', more: Partial<NotchItem> = {}): NotchItem & { yeses: number; shows: boolean[] } {
  const made = {
    id, subject: id, class: cls, speaks: true, yeses: 0, shows: [] as boolean[],
    title: () => [`${id} waits`],
    async play(stage: NotchStage, how: { unasked: boolean }): Promise<NotchItemEnd> {
      made.shows.push(how.unasked);
      const answer = await stage.offer([`${id}?`], 'yes');
      if (answer.act !== 'yes') return 'waits';
      made.yeses++;
      return 'settled';
    },
    ...more,
  };
  return made;
}

describe('arriving', () => {
  test('an item speaks up when it arrives and the notch is free, and its line is marked as unasked', async () => {
    const h = harness();
    h.inbox.add(item('a'));
    await settle();
    expect(h.said()).toBe('a?');
    expect(h.line()?.unasked).toBe(true);
    expect(h.count()).toBe(0);
    expect(h.inbox.showing()).toBe('a');
  });

  test('one that arrives while a line is up says nothing: it joins the count', async () => {
    const h = harness();
    const a = item('a'), b = item('b');
    h.inbox.add(a);
    await settle();
    h.inbox.add(b);
    await settle();
    expect(h.said()).toBe('a?');
    expect(h.count()).toBe(1);
    expect(b.shows).toEqual([]);
  });

  test('yes settles it: it is gone from the count and the notch rests', async () => {
    const h = harness();
    const a = item('a');
    h.inbox.add(a);
    await settle();
    await h.answer('yes');
    expect(a.yeses).toBe(1);
    expect(h.line()).toBeNull();
    expect(h.count()).toBe(0);
    expect(h.inbox.has('a')).toBe(false);
  });

  test('not now and a fold are not a no: the item goes back to the count', async () => {
    for (const act of ['no', 'fold'] as const) {
      const h = harness();
      h.inbox.add(item('a'));
      await settle();
      await h.answer(act);
      expect(h.line()).toBeNull();
      expect(h.count()).toBe(1);
      expect(h.inbox.has('a')).toBe(true);
    }
  });

  test('what joined the count does not speak up later by itself', async () => {
    const h = harness();
    const a = item('a'), b = item('b');
    h.inbox.add(a);
    await settle();
    h.inbox.add(b);
    await h.answer('yes');
    expect(h.line()).toBeNull();
    expect(h.count()).toBe(1);
    expect(b.shows).toEqual([]);
  });

  test('an item that does not speak only joins the count', async () => {
    const h = harness();
    h.inbox.add(item('quiet', 'rest', { speaks: false }));
    await settle();
    expect(h.line()).toBeNull();
    expect(h.count()).toBe(1);
  });

  test('with no page listening nothing speaks: it waits', async () => {
    const h = harness({ page: false });
    const a = item('a');
    h.inbox.add(a);
    await settle();
    expect(a.shows).toEqual([]);
    expect(h.inbox.count()).toBe(1);
  });

  test('news is said once and is gone, whatever is done with it', async () => {
    const h = harness();
    h.inbox.add(item('news', 'rest', { once: true }));
    await settle();
    await h.answer('fold');
    expect(h.inbox.has('news')).toBe(false);
    expect(h.count()).toBe(0);
  });
});

describe('one item per subject', () => {
  test('a second on the same subject takes the first one\'s place in the count', async () => {
    const h = harness();
    h.inbox.add(item('busy'));
    await settle();
    h.inbox.add(item('x1', 'rest', { subject: 'invoice-114' }));
    h.inbox.add(item('other'));
    h.inbox.add(item('x2', 'rest', { subject: 'invoice-114' }));
    await settle();
    expect(h.count()).toBe(2);
    expect(h.inbox.waiting().map((i) => i.id)).toEqual(['busy', 'x2', 'other']);
  });

  test('when the first is on the notch, the second takes its turn there', async () => {
    const h = harness();
    const first = item('x1', 'rest', { subject: 'invoice-114' });
    const second = item('x2', 'rest', { subject: 'invoice-114' });
    h.inbox.add(first);
    await settle();
    const old = h.line()!.id;
    h.inbox.add(second);
    await settle();
    expect(h.said()).toBe('x2?');
    expect(h.count()).toBe(0);
    // An answer to the line that was replaced is not taken for one to the new line.
    h.fromPage({ type: 'answer', id: old, act: 'yes' });
    await settle();
    expect(first.yeses + second.yeses).toBe(0);
    await h.answer('yes');
    expect(second.yeses).toBe(1);
  });
});

describe('a round', () => {
  async function three() {
    const h = harness();
    const rest = item('rest1', 'rest', { speaks: false });
    const clock = item('clock1', 'clock', { speaks: false });
    const person = item('person1', 'person', { speaks: false });
    const rest2 = item('rest2', 'rest', { speaks: false });
    for (const each of [rest, clock, person, rest2]) h.inbox.add(each);
    await settle();
    return { h, rest, clock, person, rest2 };
  }

  test('yes at rest goes through what waits: a person, then a clock, then the rest, in order of arrival', async () => {
    const { h } = await three();
    expect(h.count()).toBe(4);
    await h.open();
    const order: string[] = [];
    for (let i = 0; i < 4; i++) {
      order.push(h.said());
      expect(h.line()?.unasked).toBeUndefined();
      await h.answer('yes');
    }
    expect(order).toEqual(['person1?', 'clock1?', 'rest1?', 'rest2?']);
    // Nothing is left: the round ends on its last word, the prototype's.
    expect(h.said()).toBe('That is everything.');
    expect(h.line()).toMatchObject({ kind: 'say', mood: 'happy' });
    expect(h.count()).toBe(0);
    await h.answer('done');
    expect(h.line()).toBeNull();
  });

  test('"That is everything." is said only when it is true, and a tap on it is a tap on the resting notch', async () => {
    // Something still waits in the count: the round ends on the list, as before.
    const some = harness();
    some.inbox.add(item('a'));
    some.inbox.add(item('b'));
    await settle();
    await some.answer('fold');
    await some.open();
    await some.answer('yes');
    await some.answer('no');
    expect(some.said()).toBe('1 thing still waits');
    // The one thing that waited was found gone when its turn came: nothing was shown, so nothing is summed up.
    const gone = harness();
    gone.inbox.add({ id: 'gone', subject: 'gone', class: 'rest', title: () => ['gone'], check: () => false, play: async () => 'settled' });
    await gone.open();
    expect(gone.line()).toBeNull();
    // Something waits outside the count (replies that were seen wait in Home): it has not been everything.
    // And where that cannot be told, nothing is called everything on a guess.
    for (const elsewhere of [() => true, () => { throw new Error('the mail store is closed'); }]) {
      const more = harness({ elsewhere });
      more.inbox.add(item('a'));
      await settle();
      await more.answer('fold');
      await more.open();
      await more.answer('yes');
      expect(more.line()).toBeNull();
    }
    let homes = 0;
    const tap = harness({ home: async (stage) => { homes++; await stage.say(['Home.'], 1000); } });
    tap.inbox.add(item('a'));
    await settle();
    await tap.answer('fold');
    await tap.open();
    await tap.answer('yes');
    expect(tap.said()).toBe('That is everything.');
    // A tap while it is up opens Home at once: it does not have to be waited out.
    await tap.open();
    expect(homes).toBe(1);
    expect(tap.said()).toBe('Home.');
  });

  test('not now means next, each item comes once, and the round ends on the list of what still waits', async () => {
    const { h, person } = await three();
    await h.open();
    await h.answer('no');
    expect(h.said()).toBe('clock1?');
    await h.answer('yes');
    await h.answer('fold');
    await h.answer('yes');
    const sheet = h.line();
    expect(sheet?.kind).toBe('sheet');
    expect(h.said()).toBe('2 things still wait');
    expect(sheet?.kind === 'sheet' ? sheet.blocks.map((b) => (b.kind === 'row' ? b.id : '')) : []).toEqual(['person1', 'rest1']);
    expect(person.shows).toEqual([false]);
    await h.answer('no');
    expect(h.line()).toBeNull();
    expect(h.count()).toBe(2);
  });

  test('a row of that list opens its item', async () => {
    const { h, rest } = await three();
    await h.open();
    for (let i = 0; i < 4; i++) await h.answer('no');
    expect(h.line()?.kind).toBe('sheet');
    await h.answer('go', { row: 'rest1' });
    expect(h.said()).toBe('rest1?');
    await h.answer('yes');
    expect(rest.yeses).toBe(1);
    expect(h.line()).toBeNull();
    expect(h.count()).toBe(3);
  });

  test('the notch does not go back to the eyes between two lines of a round', async () => {
    const { h } = await three();
    await h.open();
    const before = h.pushed.length;
    await h.answer('yes');
    expect(h.pushed.slice(before).map((m) => m.type)).not.toContain('rest');
  });

  test('an item that is no longer true leaves the count without a word', async () => {
    const h = harness();
    let stillTrue = true;
    const stale = item('stale', 'person', { speaks: false, check: () => stillTrue });
    h.inbox.add(stale);
    h.inbox.add(item('other', 'rest', { speaks: false }));
    await settle();
    stillTrue = false;
    await h.open();
    expect(h.said()).toBe('other?');
    expect(stale.shows).toEqual([]);
    expect(h.inbox.has('stale')).toBe(false);
  });

  test('with nothing waiting, yes at rest opens home', async () => {
    const opened: string[] = [];
    const h = harness({ home: async (stage) => { opened.push('home'); await stage.say(['Nothing waits.'], 1000); } });
    await h.open();
    expect(opened).toEqual(['home']);
    expect(h.said()).toBe('Nothing waits.');
    await h.answer('done');
    expect(h.line()).toBeNull();
  });
});

describe('when the thing itself is over', () => {
  test('an item removed while it is on the notch leaves by itself', async () => {
    const h = harness();
    h.inbox.add(item('a'));
    await settle();
    expect(h.inbox.remove('a')).toBe(true);
    await settle();
    expect(h.line()).toBeNull();
    expect(h.count()).toBe(0);
    expect(h.inbox.remove('a')).toBe(false);
  });

  test('in a round, the next one comes', async () => {
    const h = harness();
    h.inbox.add(item('a', 'rest', { speaks: false }));
    h.inbox.add(item('b', 'rest', { speaks: false }));
    await settle();
    await h.open();
    expect(h.said()).toBe('a?');
    h.inbox.remove('a');
    await settle();
    expect(h.said()).toBe('b?');
  });

  test('one removed while it waits just lowers the count', async () => {
    const h = harness();
    h.inbox.add(item('a', 'rest', { speaks: false }));
    h.inbox.add(item('b', 'rest', { speaks: false }));
    await settle();
    h.inbox.remove('b');
    expect(h.count()).toBe(1);
  });
});

describe('giving way', () => {
  test('while something else has the notch nothing is shown, counted or opened', async () => {
    let busy = true;
    const h = harness({ busy: () => busy });
    const a = item('a');
    h.inbox.add(a);
    await settle();
    await h.open();
    expect(a.shows).toEqual([]);
    expect(h.pushed.filter((m) => m.type === 'count')).toEqual([]);
    busy = false;
    h.inbox.refresh();
    expect(h.count()).toBe(1);
  });

  test('a hold sends what is on the notch back to the count, and keeps arrivals quiet', async () => {
    const h = harness();
    const a = item('a'), b = item('b');
    h.inbox.add(a);
    await settle();
    h.inbox.hold('asleep');
    await settle();
    expect(h.line()).toBeNull();
    expect(h.count()).toBe(1);
    h.inbox.add(b);
    await settle();
    expect(b.shows).toEqual([]);
    expect(h.count()).toBe(2);
    await h.open();
    expect(h.line()).toBeNull();
    h.inbox.release('asleep');
    await h.open();
    expect(h.line()).not.toBeNull();
  });

  test('an opener gets a yes at rest first', async () => {
    const h = harness();
    h.inbox.add(item('a', 'rest', { speaks: false }));
    let woke = 0;
    h.inbox.setOpener(() => { woke++; return true; });
    await h.open();
    expect(woke).toBe(1);
    expect(h.line()).toBeNull();
    h.inbox.setOpener(null);
    await h.open();
    expect(h.said()).toBe('a?');
  });

  test('an item whose script fails is said so in the log, and waits', async () => {
    const h = harness();
    h.inbox.add(item('broken', 'rest', { play: () => Promise.reject(new Error('boom')) }));
    await settle();
    expect(h.logs.some((line) => line.includes('"broken" failed on the notch: boom'))).toBe(true);
    expect(h.inbox.has('broken')).toBe(true);
    expect(h.line()).toBeNull();
  });
});

describe('what cannot wait, and what arrived while nobody could be told', () => {
  test('an urgent item takes the notch from the one on it, which goes back to the count', async () => {
    const h = harness();
    const a = item('a');
    h.inbox.add(a);
    await settle();
    const fuse = item('fuse', 'clock', { urgent: true });
    h.inbox.add(fuse);
    await settle();
    expect(h.said()).toBe('fuse?');
    expect(h.line()?.unasked).toBe(true);
    expect(h.count()).toBe(1);
    expect(h.inbox.has('a')).toBe(true);
  });

  test('an urgent item does not take the notch from something else that has it', async () => {
    const h = harness({ busy: () => true });
    const fuse = item('fuse', 'clock', { urgent: true });
    h.inbox.add(fuse);
    await settle();
    expect(fuse.shows).toEqual([]);
  });

  test('what arrived while no notch was up is said when one comes up: one of them, an urgent one first', async () => {
    const h = harness({ page: false });
    const a = item('a'), b = item('b', 'clock', { urgent: true }), c = item('c');
    for (const each of [a, b, c]) h.inbox.add(each);
    await settle();
    h.fromPage({ type: 'hello', v: 1 });
    await settle();
    expect(h.said()).toBe('b?');
    expect(h.count()).toBe(2);
    await h.answer('yes');
    // The others had the same chance: they wait in the count.
    expect(h.line()).toBeNull();
    expect(a.shows).toEqual([]);
    // And a second hello does not bring them up either.
    h.fromPage({ type: 'hello', v: 1 });
    await settle();
    expect(h.line()).toBeNull();
    expect(h.count()).toBe(2);
  });

  test('what arrived during a hold is said when the hold ends', async () => {
    const h = harness();
    h.inbox.hold('stopped');
    const a = item('a');
    h.inbox.add(a);
    await settle();
    expect(a.shows).toEqual([]);
    h.inbox.release('stopped');
    await settle();
    expect(h.said()).toBe('a?');
    expect(h.line()?.unasked).toBe(true);
    // Releasing what is not held does nothing.
    h.inbox.release('stopped');
    await settle();
    expect(a.shows).toEqual([true]);
  });
});

describe('taken off the notch in the instant its script ends', () => {
  test('news that was said is not said again because something took the notch right behind it', async () => {
    const h = harness();
    h.inbox.add(item('news', 'rest', { once: true, play: async (stage) => { await stage.say(['Kept: the pricing.'], 1000); return 'settled'; } }));
    await settle();
    // The page says the line is over, and in the same instant everything is held.
    h.fromPage({ type: 'answer', id: h.line()!.id, act: 'done' });
    h.inbox.hold('stopped');
    await settle();
    expect(h.inbox.has('news')).toBe(false);
    expect(h.count()).toBe(0);
  });

  test('an item that settled is out of the count even if another took its place before its script returned', async () => {
    const h = harness();
    const a = item('a');
    h.inbox.add(a);
    await settle();
    h.fromPage({ type: 'answer', id: h.line()!.id, act: 'yes' });
    h.inbox.add(item('fuse', 'clock', { urgent: true }));
    await settle();
    expect(a.yeses).toBe(1);
    expect(h.inbox.has('a')).toBe(false);
    expect(h.said()).toBe('fuse?');
    expect(h.count()).toBe(0);
  });

  test('news that was cut short before it was said keeps its place', async () => {
    const h = harness();
    h.inbox.add(item('news', 'rest', { once: true, play: async (stage) => { await stage.say(['Kept: the pricing.'], 1000); return 'settled'; } }));
    await settle();
    h.inbox.hold('stopped');
    await settle();
    expect(h.inbox.has('news')).toBe(true);
    expect(h.count()).toBe(1);
  });
});

describe('second batch of the edge-case audit', () => {
  test('something urgent does not take the notch while a yes is burning its fuse: it speaks when that is over', async () => {
    const h = harness();
    let decided = 0;
    h.inbox.add({
      id: 'a', subject: 'a', class: 'rest', speaks: true, title: () => ['a'],
      play: async (stage) => {
        if ((await stage.offer(['Run it?'], 'approve')).act !== 'yes') return 'waits';
        if ((await stage.fuse(['Running it…'], 3000)) === 'done') decided++;
        return 'settled';
      },
    });
    await settle();
    await h.answer('yes');
    expect(h.line()?.kind).toBe('send');
    h.inbox.add(item('urgent', 'clock', { urgent: true }));
    await settle();
    // The fuse is still the line, and the yes still counts.
    expect(h.line()?.kind).toBe('send');
    await h.answer('done');
    expect(decided).toBe(1);
    expect(h.said()).toBe('urgent?');
  });

  test('the notch goes back to what was waited on after two urgent things in a row', async () => {
    const h = harness();
    const work = item('work', 'person', { returns: true });
    h.inbox.add(work);
    await settle();
    h.inbox.add(item('first', 'clock', { urgent: true }));
    await settle();
    h.inbox.add(item('second', 'clock', { urgent: true }));
    await settle();
    expect(h.said()).toBe('second?');
    await h.answer('yes');
    expect(h.said()).toBe('work?');
  });
});

// Pass 8: a line nobody asked for comes up only in a still moment, and never in quiet hours.
describe('speaking up only when it may', () => {
  test('what arrives while the person is typing joins the count, and speaks when their hands go still', async () => {
    let still = false;
    const h = harness({ maySpeak: () => still });
    const mail = item('mail', 'person');
    h.inbox.add(mail);
    await settle();
    expect(h.line()).toBeNull();
    expect(h.count()).toBe(1);
    still = true;
    h.inbox.calmed();
    await settle();
    expect(h.said()).toBe('mail?');
    expect(mail.shows).toEqual([true]);
  });

  // The notch's own manner, unchanged: of what arrived in the meantime one gets its say, and the others are in the count.
  test('one thing speaks in a still moment, the oldest, and the others wait in the count', async () => {
    let still = false;
    const h = harness({ maySpeak: () => still });
    h.inbox.add(item('first', 'person'));
    h.inbox.add(item('second', 'person'));
    still = true;
    h.inbox.calmed();
    await settle();
    expect(h.said()).toBe('first?');
    expect(h.count()).toBe(1);
    await h.answer('yes');
    expect(h.line()).toBeNull();
    expect(h.count()).toBe(1);
  });

  test('the person can still open the notch and find it there', async () => {
    const h = harness({ maySpeak: () => false });
    const mail = item('mail', 'person');
    h.inbox.add(mail);
    await h.open();
    expect(h.said()).toBe('mail?');
    expect(mail.shows).toEqual([false]);
  });

  test('what the person asked for, and what has a window already running, does not wait', async () => {
    const h = harness({ maySpeak: () => false });
    h.inbox.add(item('asked', 'person', { asked: true }));
    await settle();
    expect(h.said()).toBe('asked?');
    await h.answer('yes');
    h.inbox.add(item('fuse', 'clock', { urgent: true }));
    await settle();
    expect(h.said()).toBe('fuse?');
  });

  test('a notch that comes up while it may not speak says nothing until it may', async () => {
    let still = false;
    const h = harness({ page: false, maySpeak: () => still });
    h.inbox.add(item('mail', 'person'));
    h.fromPage({ type: 'hello', v: 1 });
    await settle();
    expect(h.line()).toBeNull();
    still = true;
    h.inbox.calmed();
    await settle();
    expect(h.said()).toBe('mail?');
  });

  test('a still moment with nothing waiting to speak changes nothing, and does not take the notch from what is on it', async () => {
    let still = false;
    const h = harness({ maySpeak: () => still });
    h.inbox.calmed();
    await settle();
    expect(h.line()).toBeNull();
    h.inbox.add(item('asked', 'person', { asked: true }));
    h.inbox.add(item('mail', 'person'));
    await settle();
    still = true;
    h.inbox.calmed();
    await settle();
    expect(h.said()).toBe('asked?');
  });

  test('without the rule, anything speaks whenever the notch is free, as before', async () => {
    const h = harness();
    h.inbox.add(item('mail', 'person'));
    await settle();
    expect(h.said()).toBe('mail?');
  });

  test('open() is a tap on the resting notch', async () => {
    const h = harness({ maySpeak: () => false });
    h.inbox.add(item('mail', 'person'));
    h.inbox.open();
    await settle();
    expect(h.said()).toBe('mail?');
  });
});


// The hardening audit, 17 November 2026 (pass 13).
describe('what the hardening audit found', () => {
  // "settings", "what can you do", "day one": said while the line that carries the words has the notch. What
  // they open was refused the notch, nothing opened at all, and the ledger said done.
  test('what was asked for while something has the notch comes up the moment that has ended', async () => {
    const h = harness();
    const did: string[] = [];
    let finish: () => void = () => {};
    h.inbox.present('carrier', async (stage) => { stage.put({ id: stage.id(), kind: 'listen', say: [], heard: 'settings' }); await new Promise<void>((done) => { finish = done; }); });
    await settle();
    h.inbox.after(() => { did.push(`asked, sheet opened: ${h.inbox.present('settings', (stage) => stage.sheet(['Settings'], []).then(() => {}))}`); });
    // Not yet: its own line is still up.
    expect(did).toEqual([]);
    finish();
    await settle();
    expect(did).toEqual(['asked, sheet opened: true']);
    expect(h.said()).toBe('Settings');
    // With nothing on the notch it happens at once.
    await h.answer('no');
    h.inbox.after(() => did.push('at once'));
    expect(did.at(-1)).toBe('at once');
  });

  test('it is not kept for long, and what the notch was going to hand back to has it back afterwards', async () => {
    let now = 0;
    const timers: { fn: () => void; at: number }[] = [];
    const pushed: NotchToPage[] = [];
    let onEvent: (sidecarId: string, event: { event_type: string; payload: unknown }) => void = () => {};
    const port: NotchSurfacePort = { dispatchRPC(_s, _m, params) { pushed.push((params as { message: NotchToPage }).message); return Promise.resolve({}); }, onEvent(listener) { onEvent = listener; }, onSidecarDisconnected() {} };
    const surface = new NotchSurface(port, () => {});
    const inbox = new NotchInbox(surface, { clock: { setTimeout: (fn, ms) => { const t = { fn, at: now + ms }; timers.push(t); return t; }, clearTimeout: () => {} }, log: () => {}, now: () => now });
    onEvent('pc', { event_type: NOTCH_MESSAGE_EVENT, payload: { message: { type: 'hello', v: 1 } } });
    const did: string[] = [];
    let finish: () => void = () => {};
    inbox.present('long', async () => { await new Promise<void>((done) => { finish = done; }); });
    inbox.after(() => did.push('late'));
    now += 60_000;
    finish();
    await settle();
    expect(did).toEqual([]);
  });

  // An item ends with its line still up and hands on to the next of a round. That one turns out to be gone.
  // The old line stayed for good: it could not be answered, and nothing else could take the notch.
  test('a line left for a follower that turns out to be gone does not stay on the notch', async () => {
    const h = harness();
    const first: NotchItem = { id: 'first', subject: 'first', class: 'person', speaks: false, title: () => ['first'],
      play: async (stage) => { const id = stage.id(); stage.put({ id, kind: 'offer', say: ['Morning. 1 needs you.'], yes: 'show' }); await stage.answer(id, ['yes']); return 'settled'; } };
    const gone: NotchItem = { id: 'gone', subject: 'gone', class: 'rest', speaks: false, title: () => ['gone'], check: () => false, play: async () => 'settled' };
    h.inbox.add(first);
    h.inbox.add(gone);
    await h.open();
    expect(h.said()).toBe('Morning. 1 needs you.');
    await h.answer('yes');
    // The old line is gone. What was shown was all there was, and the round says so.
    expect(h.said()).toBe('That is everything.');
    await h.answer('done');
    expect(h.line()).toBeNull();
    // And the notch can be taken again.
    h.inbox.add(item('next'));
    await settle();
    expect(h.said()).toBe('next?');
  });

  test('of several that waited to speak, when the one chosen is gone the next speaks, and when it spoke the others stay in the count', async () => {
    const h = harness({ page: false });
    h.inbox.add({ ...item('promise'), check: () => false });
    h.inbox.add(item('approval'));
    h.inbox.add(item('news'));
    h.fromPage({ type: 'hello', v: 1 });
    await settle();
    // The first was gone: the second has its say.
    expect(h.said()).toBe('approval?');
    await h.answer('yes');
    // It spoke: the third stays in the count and does not speak up by itself.
    expect(h.line()).toBeNull();
    expect(h.count()).toBe(1);
  });

  test('while everything is held nothing is presented, but for the line that belongs to the hold itself', async () => {
    const h = harness();
    h.inbox.hold('call');
    expect(h.inbox.present('offline', (stage) => stage.say(['No connection. I carry on when it is back.'], 4200).then(() => {}))).toBe(false);
    expect(h.line()).toBeNull();
    expect(h.inbox.present('call-over', (stage) => stage.say(['Call ended.'], 2000).then(() => {}), { held: true })).toBe(true);
    await settle();
    expect(h.said()).toBe('Call ended.');
  });
});

// The owner, 18 November 2026: on a call that is not listened to, what he
// says to the notch has to be taken. A call's hold keeps back what comes by
// itself and lets through what the person starts or is waiting on.
describe('a hold that lets the person\'s own things through', () => {
  const news = (id: string): NotchItem => ({ id, subject: id, class: 'person', speaks: true, title: () => [id], play: async (stage) => { await stage.say([`${id}.`], 2000); return 'settled'; } });
  const mine = (id: string): NotchItem => ({ ...news(id), asked: true, urgent: true });

  test('what comes by itself waits; what the person asked for is shown', async () => {
    const h = harness();
    h.inbox.hold('call', { own: true });
    h.inbox.add(news('mail'));
    await settle();
    expect(h.line()).toBeNull();
    h.inbox.add(mine('asked'));
    await settle();
    expect(h.said()).toBe('asked.');
    await h.answer('done');
    // Nothing else speaks until the hold is over.
    expect(h.line()).toBeNull();
    h.inbox.release('call');
    await settle();
    expect(h.said()).toBe('mail.');
  });

  test('something the person is waiting on is let through as well', async () => {
    const h = harness();
    h.inbox.hold('call', { own: true });
    h.inbox.add({ ...news('approval'), returns: true });
    await settle();
    expect(h.said()).toBe('approval.');
  });

  test('a plain hold keeps everything back, and with both holds on the plain one decides', async () => {
    const h = harness();
    h.inbox.hold('stopped');
    h.inbox.add(mine('asked'));
    await settle();
    expect(h.line()).toBeNull();
    h.inbox.release('stopped');
    await settle();
    expect(h.said()).toBe('asked.');
    await h.answer('done');
    h.inbox.hold('call', { own: true });
    h.inbox.hold('stopped');
    h.inbox.add(mine('again'));
    await settle();
    expect(h.line()).toBeNull();
  });

  test('what the person asked for stays on the notch when such a hold begins; what came by itself goes back to waiting', async () => {
    const h = harness();
    h.inbox.add(mine('asked'));
    await settle();
    h.inbox.hold('call', { own: true });
    await settle();
    expect(h.said()).toBe('asked.');
    await h.answer('done');
    h.inbox.release('call');
    h.inbox.add(news('mail'));
    await settle();
    expect(h.said()).toBe('mail.');
    h.inbox.hold('call', { own: true });
    await settle();
    expect(h.line()).toBeNull();
    expect(h.count()).toBe(1);
  });
});

// What was said with a line up is that line's answer (./said.ts): the talk keys had taken the notch, so the item is brought back with it.
describe('a line answered by voice comes back with its answer', () => {
  /** A choice of three. Each showing is a new line; what was picked is kept. */
  function choice(id = 'slot') {
    const state = { shown: 0, picked: [] as (string | undefined)[], ends: [] as string[] };
    const it: NotchItem = {
      id, subject: id, class: 'person', speaks: true, title: () => ['A choice'],
      play: async (stage) => {
        state.shown++;
        const pick = await stage.choose(['Anna asked to move Thursday. Offer a slot?'], ['Thursday at 15:00', 'Friday at 10:00', 'Monday at 9:30']);
        state.ends.push(pick.act);
        if (pick.act !== 'pick') return 'waits';
        state.picked.push(pick.option);
        await stage.say(['Offered ', pick.option ?? '', '.'], 2000);
        return 'settled';
      },
    };
    return { it, state };
  }
  const READS = 'offer|Anna asked to move Thursday. Offer a slot?|Thursday at 15:00|Friday at 10:00|Monday at 9:30';

  test('the item is on the notch again, its line is answered at once, and its script goes on from there', async () => {
    const h = harness();
    const { it, state } = choice();
    h.inbox.add(it);
    await settle();
    expect(h.said()).toBe('Anna asked to move Thursday. Offer a slot?');
    // The talk keys: something urgent takes the notch, and leaves again.
    h.inbox.add(item('talk', 'person', { urgent: true, asked: true, once: true }));
    await settle();
    await h.answer('no');
    expect(h.inbox.showing()).toBeNull();
    expect(h.inbox.replay('slot', READS, [{ act: 'pick', option: 'Friday at 10:00', index: 1 }])).toBe(true);
    await settle();
    expect(state.shown).toBe(2);
    expect(state.picked).toEqual(['Friday at 10:00']);
    expect(h.said()).toBe('Offered Friday at 10:00.');
    await h.answer('done');
    expect(h.inbox.has('slot')).toBe(false);
  });

  test('when the item shows another line than the one that was answered, that line waits for the person', async () => {
    const h = harness();
    const { it, state } = choice();
    h.inbox.add(it);
    await settle();
    await h.answer('fold');
    expect(h.inbox.replay('slot', 'offer|Some other line?|A|B', [{ act: 'pick', option: 'A', index: 0 }])).toBe(true);
    await settle();
    expect(h.said()).toBe('Anna asked to move Thursday. Offer a slot?');
    expect(state.picked).toEqual([]);
    // And it is answered by hand as ever.
    await h.answer('pick', { option: 'Monday at 9:30', index: 2 });
    expect(state.picked).toEqual(['Monday at 9:30']);
  });

  test('an answer the line does not take is dropped, not kept for a later line', async () => {
    const h = harness();
    const { it, state } = choice();
    h.inbox.add(it);
    await settle();
    await h.answer('fold');
    expect(h.inbox.replay('slot', READS, [{ act: 'yes' }])).toBe(true);
    await settle();
    expect(h.said()).toBe('Anna asked to move Thursday. Offer a slot?');
    expect(state.ends).toEqual(['fold']);
  });

  test('two lit words changed in one breath are given one after the other, and the line then waits for its yes', async () => {
    const h = harness();
    const words = { when: 'Thursday at 10:00', tone: 'yours' };
    let sent = 0;
    const say = () => ['Send it ', { word: { name: 'when', value: words.when, options: [words.when] } }, ', ', { word: { name: 'tone', value: words.tone, options: ['yours', 'short'] } }, '?'];
    h.inbox.add({
      id: 'draft', subject: 'draft', class: 'person', speaks: true, title: () => ['A draft'],
      play: async (stage) => {
        const id = stage.id();
        stage.put({ id, kind: 'offer', say: say(), yes: 'send' });
        for (;;) {
          const answer = await stage.answer(id, ['yes', 'no', 'fold', 'word']);
          if (answer.act === 'word') { if (answer.word === 'when' || answer.word === 'tone') words[answer.word] = answer.value ?? ''; stage.surface.update(id, { say: say() }); continue; }
          if (answer.act === 'yes') { sent++; return 'settled'; }
          return 'waits';
        }
      },
    });
    await settle();
    await h.answer('fold');
    expect(h.inbox.replay('draft', 'offer|Send it Thursday at 10:00, yours?|', [{ act: 'word', word: 'when', value: 'Friday at 10:00' }, { act: 'word', word: 'tone', value: 'short' }])).toBe(true);
    await settle();
    expect(words).toEqual({ when: 'Friday at 10:00', tone: 'short' });
    expect(sent).toBe(0);
    expect(h.line()).toMatchObject({ kind: 'offer', yes: 'send' });
    await h.answer('yes');
    expect(sent).toBe(1);
  });

  test('an item that is gone, a notch that is taken, and a stop are each a no', async () => {
    const h = harness();
    expect(h.inbox.replay('nothing', READS, [{ act: 'yes' }])).toBe(false);
    const { it } = choice();
    h.inbox.add(it);
    await settle();
    // It is on the notch itself: nothing is brought back over what is playing.
    expect(h.inbox.replay('slot', READS, [{ act: 'pick', option: 'Friday at 10:00', index: 1 }])).toBe(false);
    await h.answer('fold');
    h.inbox.hold('stopped');
    expect(h.inbox.replay('slot', READS, [{ act: 'pick', option: 'Friday at 10:00', index: 1 }])).toBe(false);
    h.inbox.release('stopped');
    await settle();
    // A hold that lets the person's own things through lets this through: they said it.
    h.inbox.hold('call', { own: true });
    expect(h.inbox.replay('slot', READS, [{ act: 'pick', option: 'Friday at 10:00', index: 1 }])).toBe(true);
    await settle();
    expect(h.said()).toBe('Offered Friday at 10:00.');
  });
});


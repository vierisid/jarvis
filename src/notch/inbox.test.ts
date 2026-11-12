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
function harness(options: { page?: boolean; busy?: () => boolean; home?: (stage: NotchStage) => Promise<void> } = {}) {
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
  const inbox = new NotchInbox(surface, { clock, log: (line) => logs.push(line), busy: options.busy, home: options.home });
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
    expect(h.line()).toBeNull();
    expect(h.count()).toBe(0);
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

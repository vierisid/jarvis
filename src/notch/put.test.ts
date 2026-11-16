import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { NotchInbox } from './inbox.ts';
import { attachNotchJobs, type NotchActResult, type NotchJobHands } from './jobs.ts';
import type { NotchLooked, NotchThing } from './look.ts';
import type { NotchLine, NotchPart, NotchToPage } from './protocol.ts';
import { NOTCH_HOLD_MS, attachNotchPut, heldFrom, takesAThing } from './put.ts';
import { NOTCH_MESSAGE_EVENT, NotchSurface } from './surface.ts';
import type { NotchSurfacePort } from './surface.ts';

const settle = async (): Promise<void> => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
const text = (parts: NotchPart[] | undefined): string => (parts ?? []).map((part) => (typeof part === 'string' ? part : 'em' in part ? part.em : '')).join('');

const thing = (kind: string, more: Partial<NotchThing> = {}): NotchThing => ({ kind, name: '', value: '', parts: [], ...more });
const looked = (things: NotchThing[], more: Partial<NotchLooked> = {}): NotchLooked =>
  ({ id: 'l1', how: 'loop', refused: '', app: 'Grafana', title: 'Installs', around: [], things, picture: null, window: null, ...more });

const ROWS = [
  thing('row', { parts: ['Acme', '1,200.00', 'paid'] }),
  thing('row', { parts: ['Lumen', '430.33', 'late'] }),
  thing('row', { parts: ['Northwind', '91.00', 'paid'] }),
];
const FIELD = looked([thing('field', { role: 'Edit' })], { how: 'click', app: 'Notepad', at: { x: 900, y: 500 } });

describe('what is held, and what takes it', () => {
  test('rows are held as rows: cells parted by tabs, rows by line ends', () => {
    expect(heldFrom(looked(ROWS), 5)).toEqual({ what: '3 rows', text: 'Acme\t1,200.00\tpaid\nLumen\t430.33\tlate\nNorthwind\t91.00\tpaid', app: 'Grafana', at: 5 });
  });

  test('one short thing is called by what it says, a long one by its kind', () => {
    expect(heldFrom(looked([thing('text', { name: '1,291' })]), 5)).toMatchObject({ what: '1,291', text: '1,291' });
    expect(heldFrom(looked([thing('cell', { name: 'B7', value: '42' })]), 5)).toMatchObject({ what: '42', text: '42' });
    expect(heldFrom(looked([thing('text', { name: 'Installs in the last thirty days, all channels' })]), 5)).toMatchObject({ what: 'this text' });
  });

  test('nothing is held of a look that read nothing, was refused, or was cut short where it was read', () => {
    expect(heldFrom(looked([]), 5)).toBeNull();
    expect(heldFrom(looked([thing('picture')]), 5)).toBeNull();
    expect(heldFrom(looked(ROWS, { refused: 'bank' }), 5)).toBeNull();
    // Half a text is not put anywhere.
    expect(heldFrom(looked([thing('text', { name: 'A very long paragraph that was cut where it was rea…' })]), 5)).toBeNull();
  });

  test('a field, a cell and a page of writing take a thing; a button, a link and a picture do not', () => {
    for (const place of [thing('field'), thing('cell'), thing('thing', { role: 'Document' }), thing('thing', { role: 'DataItem' }), thing('thing', { role: 'Edit' })]) expect(takesAThing(place)).toBe(true);
    for (const place of [thing('button', { role: 'Button' }), thing('link'), thing('picture'), thing('text', { role: 'Text' }), thing('row', { role: 'ListItem' })]) expect(takesAThing(place)).toBe(false);
    expect(takesAThing(undefined)).toBe(false);
  });
});

function harness(options: { result?: NotchActResult | null | 'lost'; paused?: () => boolean } = {}) {
  let toSurface: (sidecarId: string, event: { event_type: string; payload: unknown }) => void = () => {};
  const pushed: NotchToPage[] = [];
  const port: NotchSurfacePort = {
    dispatchRPC(_sidecarId, _method, params) { pushed.push((params as { message: NotchToPage }).message); return Promise.resolve({}); },
    onEvent(listener) { toSurface = listener; },
    onSidecarDisconnected() {},
  };
  const timers: { fn: () => void; at: number }[] = [];
  let now = 1_000_000;
  const clock = {
    setTimeout: (fn: () => void, ms: number) => { const timer = { fn, at: now + ms }; timers.push(timer); return timer; },
    clearTimeout: (handle: unknown) => { const at = timers.indexOf(handle as { fn: () => void; at: number }); if (at >= 0) timers.splice(at, 1); },
  };
  const surface = new NotchSurface(port, () => {});
  const fromPage = (message: unknown): void => toSurface('pc', { event_type: NOTCH_MESSAGE_EVENT, payload: { message } });
  fromPage({ type: 'hello', v: 1 });
  const inbox = new NotchInbox(surface, { clock, log: () => {} });
  const sent: Record<string, unknown>[] = [];
  const hands: NotchJobHands = {
    act(request) {
      sent.push(request);
      if (request.do !== 'paste') return Promise.resolve({ done: true });
      if (options.result === 'lost') return Promise.reject(new Error('no answer'));
      return Promise.resolve(options.result === undefined
        ? { done: true, app: 'Notepad', win: { id: '0x9', pid: 9, w: 800, h: 600 }, pt: { x: 200, y: 300 }, shape: { rows: 3, cols: 3, hash: 'abc' } }
        : options.result);
    },
  };
  const jobs = attachNotchJobs(inbox, { db: new Database(':memory:'), hands, sleep: async () => {}, now: () => now, log: () => {} });
  const holds: { what: string; ms: number }[] = [];
  const put = attachNotchPut({
    inbox, jobs, hands, paused: options.paused, now: () => now, log: () => {},
    hold: (_sidecarId, what, ms) => { holds.push({ what, ms }); },
  });
  const line = (): NotchLine | null => surface.current().line;
  const said = (): string => text(line()?.say);
  const reply = async (act: string): Promise<void> => {
    fromPage({ type: 'answer', id: line()!.id, act });
    await settle();
  };
  return { put, jobs, sent, holds, line, said, reply, advance: (ms: number) => { now += ms; }, now: () => now };
}

describe('show it a thing, then point at a place', () => {
  // The plan's test, step 5: "Show it a number in one app, then point at a field in Notepad. Yes. It is there."
  test('what was shown is held, and the desktop app is told so it can say "Put ... here" before the click', async () => {
    const h = harness();
    // The look goes on to answer as it always does.
    expect(h.put.shown('pc', looked(ROWS))).toBe(false);
    expect(h.holds).toEqual([{ what: '3 rows', ms: NOTCH_HOLD_MS }]);
    expect(h.put.held()).toMatchObject({ what: '3 rows' });
  });

  test('a click on a field while it is held asks, and a yes puts it there', async () => {
    const h = harness();
    h.put.shown('pc', looked(ROWS));
    h.advance(20_000);
    // Taken: the look itself says nothing.
    expect(h.put.shown('pc', FIELD)).toBe(true);
    await settle();
    expect(h.said()).toBe('Put 3 rows here?');
    expect(h.line()).toMatchObject({ kind: 'offer', yes: 'put' });
    // Nothing has been done yet.
    expect(h.sent).toEqual([]);
    await h.reply('yes');
    expect(h.sent[0]).toEqual({ do: 'paste', screen: true, x: 900, y: 500, text: 'Acme\t1,200.00\tpaid\nLumen\t430.33\tlate\nNorthwind\t91.00\tpaid', hand: 0 });
    // The pointer goes home when it is done.
    expect(h.sent[1]).toEqual({ do: 'home' });
    expect(h.said()).toBe('There. It is in Notepad.');
    // It is in what was done today. Into a page of writing, it cannot be taken back from there.
    expect(h.jobs.done(0)).toMatchObject([{ text: 'Put 3 rows from Grafana into Notepad', undoable: false }]);
    // Put once: it is not held any more.
    expect(h.put.held()).toBeNull();
    expect(h.holds.at(-1)).toEqual({ what: '', ms: 0 });
  });

  test('what went into a cell can be taken back', async () => {
    const h = harness();
    h.put.shown('pc', looked(ROWS));
    h.put.shown('pc', looked([thing('cell', { role: 'DataItem', name: 'B7' })], { how: 'click', app: 'Excel', at: { x: 400, y: 300 } }));
    await settle();
    await h.reply('yes');
    expect(h.jobs.done(0)).toMatchObject([{ undoable: true }]);
    expect(h.jobs.store.since(0)[0]!.puts).toEqual([{ win: { id: '0x9', pid: 9, w: 800, h: 600 }, x: 200, y: 300, rows: 3, cols: 3, hash: 'abc' }]);
    // Never the text.
    expect(JSON.stringify(h.jobs.store.since(0))).not.toContain('Acme');
  });

  test('Esc puts nothing, and the thing is still held', async () => {
    const h = harness();
    h.put.shown('pc', looked(ROWS));
    h.put.shown('pc', FIELD);
    await settle();
    await h.reply('no');
    expect(h.sent).toEqual([]);
    expect(h.put.held()).toMatchObject({ what: '3 rows' });
  });

  test('a click on something that takes nothing is a look like any other, and is what is held from then on', async () => {
    const h = harness();
    h.put.shown('pc', looked(ROWS));
    const button = looked([thing('button', { role: 'Button', name: 'Send' })], { how: 'click', at: { x: 10, y: 10 } });
    expect(h.put.shown('pc', button)).toBe(false);
    expect(h.put.held()).toMatchObject({ what: 'Send' });
    // Circling a field is looking at it, not pointing at a place.
    expect(h.put.shown('pc', { ...FIELD, how: 'loop' })).toBe(false);
  });

  test('after ninety seconds it has forgotten, and says so instead of putting something stale', async () => {
    const h = harness();
    h.put.shown('pc', looked(ROWS));
    h.advance(NOTCH_HOLD_MS + 1000);
    expect(h.put.held()).toBeNull();
    expect(h.put.shown('pc', FIELD)).toBe(true);
    await settle();
    expect(h.said()).toBe('I no longer have what you showed me. Show me again, then point here.');
    expect(h.sent).toEqual([]);
    // Much later a click on a field is just a look.
    h.put.shown('pc', looked(ROWS));
    h.advance(10 * 60_000);
    expect(h.put.shown('pc', FIELD)).toBe(false);
  });

  test('when it cannot be put there, it says why and that nothing was put', async () => {
    const h = harness({ result: { done: false, why: 'elevated' } });
    h.put.shown('pc', looked(ROWS));
    h.put.shown('pc', FIELD);
    await settle();
    await h.reply('yes');
    expect(h.said()).toBe('That window runs as administrator, and I cannot reach it. Nothing was put there.');
    expect(h.jobs.done(0)).toEqual([]);
    // It is still held: the person can point somewhere else.
    expect(h.put.held()).toMatchObject({ what: '3 rows' });
  });

  test('a lost answer is not called done: it says to look', async () => {
    const h = harness({ result: 'lost' });
    h.put.shown('pc', looked(ROWS));
    h.put.shown('pc', FIELD);
    await settle();
    await h.reply('yes');
    expect(h.said()).toBe('I lost touch with your computer in the middle of it. Look whether it is there.');
    expect(h.jobs.done(0)).toEqual([]);
  });

  test('with everything stopped a yes puts nothing', async () => {
    const h = harness({ paused: () => true });
    h.put.shown('pc', looked(ROWS));
    h.put.shown('pc', FIELD);
    await settle();
    await h.reply('yes');
    expect(h.said()).toBe('Everything is stopped. Wake me first.');
    expect(h.sent).toEqual([]);
  });

  test('a look that was refused is neither held nor a place', () => {
    const h = harness();
    expect(h.put.shown('pc', looked(ROWS, { refused: 'password' }))).toBe(false);
    expect(h.put.held()).toBeNull();
    h.put.shown('pc', looked(ROWS));
    expect(h.put.shown('pc', { ...FIELD, refused: 'bank' })).toBe(false);
  });
});

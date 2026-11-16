import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { NOTCH_CATCH_QUIET_MS, NOTCH_WATCH_EVENT, attachNotchCatch, countRequest } from './catch.ts';
import { NotchInbox } from './inbox.ts';
import { attachNotchJobs, type NotchActResult, type NotchJobHands } from './jobs.ts';
import type { NotchLine, NotchPart, NotchToPage } from './protocol.ts';
import { findRounds, type WatchStep, type WatchWin } from './rounds.ts';
import { NOTCH_MESSAGE_EVENT, NotchSurface } from './surface.ts';
import type { NotchSurfacePort } from './surface.ts';

const settle = async (): Promise<void> => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
const text = (parts: NotchPart[] | undefined): string => (parts ?? []).map((part) => (typeof part === 'string' ? part : 'em' in part ? part.em : '')).join('');

const FILE: WatchWin = { id: '0x1a', pid: 100, w: 900, h: 700 };
const SHEET: WatchWin = { id: '0x2b', pid: 200, w: 1200, h: 800 };

function harness(options: { left?: number | null; paused?: () => boolean; teaching?: () => boolean; rows?: 'unseen' | number } = {}) {
  let toSurface: (sidecarId: string, event: { event_type: string; payload: unknown }) => void = () => {};
  let toCatch: (sidecarId: string, event: { event_type: string; payload: unknown }) => void = () => {};
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
  /** Requests that are steps of a job wait here until the test lets them through. */
  const waiting: (() => void)[] = [];
  const hands: NotchJobHands = {
    act(request) {
      sent.push(request);
      const answer: NotchActResult = request.do === 'copy' ? { done: true, empty: false, rows: 1, cols: 2, hash: 'h' } : { done: true };
      // The rows as the screen shows them: seen, and exactly as far apart as the hand went, unless a test says otherwise.
      if (request.do === 'pitch') {
        return Promise.resolve(options.rows === 'unseen' ? { done: true, known: false } : { done: true, known: true, dy: typeof options.rows === 'number' ? options.rows : (request.dy as number) });
      }
      if (request.do === 'home' || request.do === 'hand') return Promise.resolve(answer);
      return new Promise((resolve) => { waiting.push(() => resolve(answer)); });
    },
  };
  const counted: Record<string, unknown>[] = [];
  const logs: string[] = [];
  const jobs = attachNotchJobs(inbox, { db: new Database(':memory:'), hands, sleep: async () => {}, log: () => {} });
  const catcher = attachNotchCatch({ onEvent(listener) { toCatch = listener; } }, {
    inbox, jobs, hands, paused: options.paused, teaching: options.teaching, now: () => now,
    count: options.left === undefined ? undefined : async (request) => { counted.push(request); return options.left ?? null; },
    log: (line) => logs.push(line),
  });
  let ts = now;
  const tell = (payload: Record<string, unknown>): void => { now += 300; ts = now; toCatch('pc', { event_type: NOTCH_WATCH_EVENT, payload: { ...payload, ts } }); };
  const click = (win: WatchWin, x: number, y: number): void => tell({ kind: 'click', app: win === FILE ? 'notepad' : 'excel', win, pt: { x, y } });
  const keys = (win: WatchWin, spec: string): void => tell({ kind: 'keys', app: win === FILE ? 'notepad' : 'excel', win, keys: spec });
  /** The person copies row `n` of the file into the sheet by hand. */
  const row = (n: number): void => { click(FILE, 120, 200 + 22 * n); keys(FILE, 'ctrl,c'); click(SHEET, 300, 400 + 20 * n); keys(SHEET, 'ctrl,v'); };
  const line = (): NotchLine | null => surface.current().line;
  const said = (): string => text(line()?.say);
  const reply = async (act: string, more: Record<string, unknown> = {}): Promise<void> => {
    fromPage({ type: 'answer', id: line()!.id, act, ...more });
    await settle();
  };
  const pass = async (ms: number): Promise<void> => {
    now += ms;
    for (const timer of [...timers]) if (timer.at <= now) { const at = timers.indexOf(timer); if (at >= 0) timers.splice(at, 1); timer.fn(); }
    await settle();
  };
  const answer = async (n: number): Promise<void> => { for (let i = 0; i < n; i++) { await settle(); waiting.shift()?.(); await settle(); } };
  return { catcher, jobs, sent, counted, logs, tell, click, keys, row, line, said, reply, pass, answer, advance: (ms: number) => { now += ms; } };
}

describe('catching a job the person does twice by hand', () => {
  // The plan's test, step 7: "Without saying anything, paste two rows by hand. It offers to take over the rest."
  test('after the second row it offers to do the rest, and says how many are left', async () => {
    const h = harness({ left: 6 });
    h.row(0);
    await settle();
    expect(h.line()).toBeNull();
    h.row(1);
    await settle();
    await h.pass(500);
    expect(h.said()).toBe('I can take it from here. 6 left.');
    expect(h.line()).toMatchObject({ kind: 'offer', yes: 'take over', unasked: true });
    // First the rows were measured on the screen, at both places the round touches.
    expect(h.sent.slice(0, 2)).toEqual([
      { do: 'pitch', win: FILE, x: 120, y: 222, dy: 22 },
      { do: 'pitch', win: SHEET, x: 300, y: 420, dy: 20 },
    ]);
    // Then the baton: Jarvis's pointer comes up beside the person's own.
    expect(h.sent[2]).toEqual({ do: 'hand', beside: true, hand: 0 });
    // What it counted from: the place in the file the rows come from, and how far each is from the last.
    expect(h.counted[0]).toMatchObject({ do: 'count', win: FILE, x: 120, y: 222, dx: 0, dy: 22 });
    // The log says how much was seen, and nothing of where.
    expect(h.logs).toEqual(['[notch] a job done twice by hand was seen: 4 step(s) a round, 2 round(s) shown']);
  });

  test('yes, and it does them, from the row after the last one done by hand', async () => {
    const h = harness({ left: 3 });
    h.row(0);
    h.row(1);
    await settle();
    await h.pass(500);
    await h.reply('yes');
    await settle();
    expect(h.line()).toMatchObject({ kind: 'work', steps: 3, done: 0 });
    const steps = h.sent.filter((request) => request.do !== 'hand' && request.do !== 'home' && request.do !== 'pitch');
    expect(steps[0]).toEqual({ do: 'click', win: FILE, x: 120, y: 244, hand: 0 });
    await h.answer(12);
    await settle();
    expect(h.said()).toBe('Done. 3 pasted.');
  });

  test('a third row done by hand while the offer is up moves the start on with it', async () => {
    const h = harness({ left: 3 });
    h.row(0);
    h.row(1);
    await settle();
    await h.pass(500);
    h.row(2);
    await settle();
    await h.reply('yes');
    await settle();
    const steps = h.sent.filter((request) => request.do === 'click');
    // The fourth row, not the third again.
    expect(steps[0]).toMatchObject({ win: FILE, y: 266 });
  });

  test('with no count to be had, the sentence makes none up, and it runs until nothing is left to copy', async () => {
    const h = harness({ left: null });
    h.row(0);
    h.row(1);
    await settle();
    await h.pass(500);
    expect(h.said()).toBe('I can take it from here.');
    await h.reply('yes');
    await settle();
    // No beads: how many there will be is not known.
    expect(h.line()).toMatchObject({ kind: 'work', steps: 0 });
  });

  test('turned down, it is not offered again for the same job for ten minutes', async () => {
    const h = harness({ left: 6 });
    h.row(0);
    h.row(1);
    await settle();
    await h.pass(500);
    await h.reply('no');
    expect(h.line()).toBeNull();
    // The pointer goes home.
    expect(h.sent.at(-1)).toEqual({ do: 'home' });
    h.row(2);
    h.row(3);
    await settle();
    await h.pass(500);
    expect(h.line()).toBeNull();
    h.advance(NOTCH_CATCH_QUIET_MS);
    h.row(4);
    h.row(5);
    await settle();
    await h.pass(500);
    expect(h.said()).toBe('I can take it from here. 6 left.');
  });

  test('nothing is left to do: it says so and starts nothing', async () => {
    const h = harness({ left: 0 });
    h.row(0);
    h.row(1);
    await settle();
    await h.pass(500);
    // Nothing counted yet is not "0 left" in the offer.
    expect(h.said()).toBe('I can take it from here.');
    await h.reply('yes');
    expect(h.said()).toBe('Nothing left to do there.');
    expect(h.jobs.busy()).toBe(false);
  });
});

describe('where each step lands', () => {
  // Found by review before the first hand test: two clicks by hand are never exactly one row apart.
  test('it goes on by how far apart the rows really are, not by how far the hand went', async () => {
    // The hand went 22 and 20. On the screen the rows are 24.5 apart in both windows.
    const h = harness({ left: 9, rows: 24.5 });
    h.row(0);
    h.row(1);
    await settle();
    await h.pass(500);
    await h.reply('yes');
    await settle();
    await h.answer(36);
    const into = h.sent.filter((request) => request.do === 'click' && (request.win as WatchWin).id === SHEET.id).map((request) => request.y);
    // 420 + 24.5 each time, to the nearest pixel. By the hand's own 20 the ninth would be at 600: nearly two rows off.
    expect(into).toEqual([445, 469, 494, 518, 543, 567, 592, 616, 641]);
  });

  test('where the rows cannot be seen it offers nothing, and does not keep measuring', async () => {
    const h = harness({ left: 6, rows: 'unseen' });
    h.row(0);
    h.row(1);
    await settle();
    await h.pass(500);
    expect(h.line()).toBeNull();
    expect(h.logs).toEqual(['[notch] a job done twice by hand was seen, and not offered: the rows could not be seen clearly enough to go on']);
    const measured = h.sent.length;
    h.row(2);
    await settle();
    expect(h.sent.length).toBe(measured);
    // Asked for by voice, it says why not.
    expect(await h.catcher.take(9)).toBe('unseen');
    expect(h.jobs.busy()).toBe(false);
  });
});

describe('what it does not offer for', () => {
  test('a job with typing in it: it did not see that part', async () => {
    const h = harness({ left: 6 });
    for (const n of [0, 1]) { h.click(SHEET, 300, 400 + 20 * n); h.tell({ kind: 'typed' }); h.keys(SHEET, 'enter'); }
    await settle();
    await h.pass(500);
    expect(h.line()).toBeNull();
  });

  // The plan's test, step 7: "Type in a password field: it watched nothing."
  test('anything across a moment the desktop app looked away', async () => {
    const h = harness({ left: 6 });
    h.row(0);
    h.tell({ kind: 'gap' });
    h.row(1);
    await settle();
    await h.pass(500);
    expect(h.line()).toBeNull();
  });

  test('what the person does while Jarvis is working, or while they are showing it a job', async () => {
    let teaching = true;
    const h = harness({ left: 6, teaching: () => teaching });
    h.row(0);
    h.row(1);
    await settle();
    await h.pass(500);
    expect(h.line()).toBeNull();
    // What was seen during the showing is not kept for after it.
    teaching = false;
    h.row(2);
    await settle();
    await h.pass(500);
    expect(h.line()).toBeNull();
  });

  test('anything while everything is stopped', async () => {
    const h = harness({ left: 6, paused: () => true });
    h.row(0);
    h.row(1);
    await settle();
    await h.pass(500);
    expect(h.line()).toBeNull();
  });

  test('two clicks: that is not yet a pattern. Something that is not a shape is not kept at all', async () => {
    const h = harness({ left: 6 });
    h.click(SHEET, 40, 300);
    h.click(SHEET, 40, 324);
    h.tell({ kind: 'keys', keys: 'hello world', win: SHEET });
    h.tell({ kind: 'click', win: SHEET, pt: { x: 40, y: 348 }, text: 'what was typed' });
    await settle();
    await h.pass(500);
    // The third click makes it a pattern of three; the junk in between was dropped, not kept as a step.
    expect(h.said()).toBe('I can take it from here. 6 left.');
  });
});

describe('"do the rest", said', () => {
  test('it takes over from where the person is, for the number said', async () => {
    const h = harness({ left: 6 });
    h.row(0);
    h.row(1);
    await settle();
    expect(h.catcher.last()?.steps.length).toBe(4);
    expect(await h.catcher.take(9)).toBe('started');
    await settle();
    expect(h.line()).toMatchObject({ kind: 'work', steps: 9 });
    // What was seen before is not a job to offer again when this one ends.
    expect(h.catcher.last()).toBeNull();
  });

  test('with nothing begun by hand there is nothing to take over', async () => {
    const h = harness({ left: 6 });
    expect(await h.catcher.take(9)).toBe('none');
    h.row(0);
    expect(await h.catcher.take(null)).toBe('none');
  });

  test('a job that copies nothing and cannot be counted needs a number', async () => {
    const h = harness({ left: null });
    for (const n of [0, 1, 2]) { h.click(SHEET, 40, 300 + 24 * n); h.keys(SHEET, 'delete'); }
    await settle();
    expect(await h.catcher.take(null)).toBe('how-many');
    expect(await h.catcher.take(4)).toBe('started');
  });
});

describe('what is counted', () => {
  test('from the place the things come from, and no further than the window', () => {
    let at = 0;
    const steps: WatchStep[] = [];
    for (const n of [0, 1]) {
      steps.push({ kind: 'click', app: 'notepad', win: FILE, x: 120, y: 600 + 22 * n, at: (at += 1) }, { kind: 'keys', app: 'notepad', win: FILE, keys: 'ctrl,c', at: (at += 1) },
        { kind: 'click', app: 'excel', win: SHEET, x: 300, y: 400 + 20 * n, at: (at += 1) }, { kind: 'keys', app: 'excel', win: SHEET, keys: 'ctrl,v', at: (at += 1) });
    }
    // The file is 700 high and the last row clicked was at 622: three more fit.
    expect(countRequest(findRounds(steps)!)).toEqual({ do: 'count', win: FILE, x: 120, y: 622, dx: 0, dy: 22, most: 3 });
  });
});

import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { attachNotchDay, notchBackLine, notchEveningLine, notchMorningLine } from './day.ts';
import { NotchInbox } from './inbox.ts';
import type { NotchAnswerAct, NotchLine, NotchPart, NotchToPage } from './protocol.ts';
import { NotchSettings } from './settings.ts';
import type { NotchMeeting } from './soon.ts';
import { NOTCH_MESSAGE_EVENT, NotchSurface, type NotchSurfacePort } from './surface.ts';

const MIN = 60_000;
/** A Monday at 09:00, on this machine's clock. */
const NINE = new Date(2026, 10, 16, 9, 0).getTime();
const settle = async (): Promise<void> => { for (let i = 0; i < 40; i++) await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, 2)); for (let i = 0; i < 40; i++) await Promise.resolve(); };
const text = (parts: NotchPart[] | null | undefined): string => (parts ?? []).map((part) => (typeof part === 'string' ? part : 'em' in part ? part.em : '')).join('');
const meeting = (title: string, startInMin: number): NotchMeeting => ({ title, start: NINE + startInMin * MIN, end: NINE + (startInMin + 30) * MIN });

function harness(options: { done?: number; waiting?: number; mailNew?: number; away?: boolean; calendar?: NotchMeeting[] } = {}) {
  let onEvent: (sidecarId: string, event: { event_type: string; payload: unknown }) => void = () => {};
  const pushed: NotchToPage[] = [];
  const port: NotchSurfacePort = {
    dispatchRPC(_sidecarId, _method, params) { pushed.push((params as { message: NotchToPage }).message); return Promise.resolve({}); },
    onEvent(listener) { onEvent = listener; },
    onSidecarDisconnected() {},
  };
  const surface = new NotchSurface(port, () => {});
  const fromPage = (message: unknown): void => onEvent('pc', { event_type: NOTCH_MESSAGE_EVENT, payload: { message } });
  fromPage({ type: 'hello', v: 1 });
  let homes = 0;
  const inbox = new NotchInbox(surface, { log: () => {}, home: async (stage) => { homes++; await stage.say(['Home.'], 1000); } });
  const state = { now: NINE, done: options.done ?? 0, waiting: options.waiting ?? 0, mailNew: options.mailNew ?? 0, away: options.away ?? false, calendar: options.calendar ?? [], told: 0, opened: 0, asked: [] as [number, number][], looks: 0 };
  const day = attachNotchDay(inbox, {
    settings: new NotchSettings(new Database(':memory:')),
    done: (since, until) => { state.asked.push([since, until]); return state.done; },
    waiting: () => state.waiting,
    away: () => state.away,
    mail: { newSince: () => state.mailNew, told: () => { state.told++; }, open: async (stage) => { state.opened++; await stage.say(['The list.'], 1000); } },
    calendar: { ahead: () => state.calendar, look: async () => { state.looks++; return true; } },
    now: () => state.now,
    log: () => {},
  });
  const line = (): NotchLine | null => surface.current().line;
  return {
    day, inbox, state, line,
    homes: () => homes,
    said: (): string => text(line()?.say),
    async answer(act: NotchAnswerAct): Promise<void> { fromPage({ type: 'answer', id: line()!.id, act }); await settle(); },
  };
}

describe('the three lines, from their numbers', () => {
  test('the morning', () => {
    expect(text(notchMorningLine(2, 3))).toBe('Morning. 2 things done overnight. 3 need you.');
    expect(text(notchMorningLine(1, 1))).toBe('Morning. 1 thing done overnight. 1 needs you.');
    expect(text(notchMorningLine(2, 0))).toBe('Morning. 2 things done overnight. Nothing needs you.');
    expect(text(notchMorningLine(0, 3))).toBe('Morning. Nothing was done overnight. 3 things need you.');
    expect(text(notchMorningLine(0, 0))).toBe('Morning. Nothing happened overnight, and nothing needs you.');
  });

  test('the evening', () => {
    expect(text(notchEveningLine(5, 2))).toBe('Today: 5 things done. 2 still wait.');
    expect(text(notchEveningLine(1, 1))).toBe('Today: 1 thing done. 1 still waits.');
    expect(text(notchEveningLine(0, 0))).toBe('Nothing was done today. Nothing waits.');
  });

  test('back: who wrote, and what moved', () => {
    const moved: NotchPart[] = [{ em: 'Board call' }, ' moved to ', { em: '16:00' }];
    const added: NotchPart[] = [{ em: 'Demo' }, ' was added, ', { em: '15:00' }];
    expect(text(notchBackLine(3, []))).toBe('While you were away: 3 people wrote and are waiting for a reply.');
    expect(text(notchBackLine(0, [moved]))).toBe('While you were away: Board call moved to 16:00.');
    expect(text(notchBackLine(1, [moved]))).toBe('While you were away: 1 person wrote and is waiting for a reply, and Board call moved to 16:00.');
    expect(text(notchBackLine(0, [moved, added]))).toBe('While you were away: Board call moved to 16:00, and 1 more change in your calendar.');
    expect(text(notchBackLine(0, [moved, added, added]))).toBe('While you were away: Board call moved to 16:00, and 2 more changes in your calendar.');
    // One new mail is its own line, and nothing new is nothing to say.
    expect(notchBackLine(1, [])).toBeNull();
    expect(notchBackLine(0, [])).toBeNull();
  });
});

describe('the morning line', () => {
  test('says what was done since they left and how many need them, and yes shows what waits', async () => {
    const h = harness({ done: 2, waiting: 3 });
    h.day.morning({ since: NINE - 14 * 60 * MIN, ms: 14 * 60 * MIN });
    await settle();
    expect(h.said()).toBe('Morning. 2 things done overnight. 3 need you.');
    expect(h.line()).toMatchObject({ kind: 'offer', yes: 'show' });
    // Counted from when they left, to now.
    expect(h.state.asked.at(-1)).toEqual([NINE - 14 * 60 * MIN, NINE]);
    // The replies it counted have been told of: they do not each speak up after it.
    expect(h.state.told).toBe(1);
    await h.answer('yes');
    expect(h.homes()).toBe(1);
  });

  test('with nothing known of when they left, overnight is twelve hours; with nothing waiting it only says so', async () => {
    const h = harness({ done: 1, waiting: 0 });
    h.day.morning({ since: null, ms: 0 });
    await settle();
    expect(h.said()).toBe('Morning. 1 thing done overnight. Nothing needs you.');
    expect(h.line()).toMatchObject({ kind: 'say' });
    expect(h.state.asked.at(-1)).toEqual([NINE - 12 * 60 * MIN, NINE]);
  });

  test('the numbers are counted when it is said, not when the day began', async () => {
    const h = harness({ done: 1, waiting: 2 });
    h.inbox.present('other', async (stage) => { await stage.say(['Something else.'], 1000); });
    await settle();
    h.day.morning({ since: null, ms: 0 });
    h.state.waiting = 5;
    await h.answer('done');
    await h.inbox.open();
    await settle();
    expect(h.said()).toBe('Morning. 1 thing done overnight. 5 need you.');
  });
});

describe('back after being away', () => {
  test('several new mails are one line, and yes opens the list', async () => {
    const h = harness({ mailNew: 3 });
    h.day.left(NINE);
    h.state.now = NINE + 40 * MIN;
    await h.day.back({ since: NINE, ms: 40 * MIN });
    await settle();
    expect(h.said()).toBe('While you were away: 3 people wrote and are waiting for a reply.');
    expect(h.state.told).toBe(1);
    await h.answer('yes');
    expect(h.state.opened).toBe(1);
  });

  test('a meeting that moved is said, read afresh from the calendar', async () => {
    const h = harness({ calendar: [meeting('Board call', 120)] });
    h.day.left(NINE);
    h.state.calendar = [meeting('Board call', 180)];
    h.state.now = NINE + 30 * MIN;
    await h.day.back({ since: NINE, ms: 30 * MIN });
    await settle();
    expect(h.state.looks).toBe(1);
    expect(h.said()).toBe('While you were away: Board call moved to 12:00.');
    expect(h.line()).toMatchObject({ kind: 'say' });
    expect(h.state.told).toBe(0);
  });

  test('one new mail, or nothing, is no line: the mail speaks for itself', async () => {
    const one = harness({ mailNew: 1 });
    one.day.left(NINE);
    await one.day.back({ since: NINE, ms: 30 * MIN });
    await settle();
    expect(one.line()).toBeNull();
    expect(one.state.told).toBe(0);
  });

  test('replies answered before the line is said are not spoken of', async () => {
    const h = harness({ mailNew: 2 });
    h.inbox.present('other', async (stage) => { await stage.say(['Something else.'], 1000); });
    await settle();
    await h.day.back({ since: NINE, ms: 30 * MIN });
    h.state.mailNew = 0;
    await h.answer('done');
    await h.inbox.open();
    await settle();
    expect(h.said()).not.toContain('While you were away');
  });
});

describe('the evening line', () => {
  test('is said once from six in the evening, with the numbers of the day, and not to an empty chair', async () => {
    const h = harness({ done: 4, waiting: 1 });
    h.state.now = new Date(2026, 10, 16, 17, 59).getTime();
    h.day.tick();
    await settle();
    expect(h.line()).toBeNull();
    h.state.now = new Date(2026, 10, 16, 18, 0).getTime();
    h.state.away = true;
    h.day.tick();
    await settle();
    expect(h.line()).toBeNull();
    h.state.away = false;
    h.day.tick();
    await settle();
    expect(h.said()).toBe('Today: 4 things done. 1 still waits.');
    // Counted from midnight.
    expect(h.state.asked.at(-1)![0]).toBe(new Date(2026, 10, 16, 0, 0).getTime());
    await h.answer('done');
    h.state.now += 30 * MIN;
    h.day.tick();
    await settle();
    expect(h.line()).toBeNull();
  });
});

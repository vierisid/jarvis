import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { attachNotchDay, notchBackLine, notchEveningLine, notchMorningLine, notchMoveAt, notchSlippedLine } from './day.ts';
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

function harness(options: { done?: number; waiting?: number; mailNew?: number; away?: boolean; calendar?: NotchMeeting[]; overnight?: (row: string) => NotchPart[] | null | 'left'; slipped?: { id: string; what: string }[]; cannotMove?: boolean } = {}) {
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
  const state = {
    now: NINE, done: options.done ?? 0, waiting: options.waiting ?? 0, mailNew: options.mailNew ?? 0, away: options.away ?? false, calendar: options.calendar ?? [], told: 0, opened: 0, asked: [] as [number, number][], looks: 0,
    /** The receipts of the night, as rows: what was taken back is gone from them. */
    receipts: [{ id: 'chase:c1', text: "Getting Sam's answer by Friday" }, { id: 'job:j1', text: 'Pasted 7 from Notepad into Excel' }], since: [] as number[], undone: [] as string[],
    /** What was promised for today and not kept, and what was moved where. */
    slipped: [...(options.slipped ?? [])], moved: [] as { ids: string[]; at: number }[], spans: [] as [number, number][],
  };
  const day = attachNotchDay(inbox, {
    settings: new NotchSettings(new Database(':memory:')),
    done: (since, until) => { state.asked.push([since, until]); return state.done; },
    waiting: () => state.waiting,
    away: () => state.away,
    mail: { newSince: () => state.mailNew, told: () => { state.told++; }, open: async (stage) => { state.opened++; await stage.say(['The list.'], 1000); } },
    calendar: { ahead: () => state.calendar, look: async () => { state.looks++; return true; } },
    ...(options.slipped ? {
      slipped: {
        today: (since: number, until: number) => { state.spans.push([since, until]); return state.slipped; },
        move: (ids: string[], at: number) => { if (options.cannotMove) return 0; state.moved.push({ ids, at }); state.slipped = state.slipped.filter((one) => !ids.includes(one.id)); return ids.length; },
      },
    } : {}),
    ...(options.overnight ? {
      overnight: {
        blocks: (since: number) => { state.since.push(since); return state.receipts.map((one) => ({ kind: 'row' as const, id: one.id, lead: '03:10', say: [one.text], buttons: [{ id: 'undo', label: 'Undo', quiet: true }] })); },
        undo: (row: string) => { state.undone.push(row); const said = options.overnight!(row); if (said !== null && said !== 'left') state.receipts = state.receipts.filter((one) => one.id !== row); return said; },
      },
    } : {}),
    now: () => state.now,
    log: () => {},
  });
  const line = (): NotchLine | null => surface.current().line;
  return {
    day, inbox, state, line,
    homes: () => homes,
    said: (): string => text(line()?.say),
    async answer(act: NotchAnswerAct, more: Record<string, unknown> = {}): Promise<void> { fromPage({ type: 'answer', id: line()!.id, act, ...more }); await settle(); },
    rows: (): string[] => { const shown = line(); return shown?.kind === 'sheet' ? shown.blocks.map((block) => ('say' in block ? text(block.say as NotchPart[]) : '')) : []; },
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
    // Pass 12: it tells of several things, so it comes in from both sides at once.
    expect(h.line()).toMatchObject({ arrive: 'pair', unasked: true });
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

// The prototype: "Morning. 2 jobs done overnight. 2 need you." and yes opens "Overnight", with receipts and Undo.
describe('the morning line opens Overnight', () => {
  const SINCE = NINE - 14 * 60 * MIN;

  test('yes shows the receipts of what was done since they left, and how many things need them', async () => {
    const h = harness({ done: 2, waiting: 3, overnight: () => null });
    h.day.morning({ since: SINCE, ms: 14 * 60 * MIN });
    await settle();
    expect(h.said()).toBe('Morning. 2 things done overnight. 3 need you.');
    await h.answer('yes');
    expect(h.said()).toBe('Overnight');
    expect(h.line()).toMatchObject({ kind: 'sheet', yes: 'show', stay: true });
    expect(h.rows()).toEqual(["Getting Sam's answer by Friday", 'Pasted 7 from Notepad into Excel', '3 things need you.']);
    // The receipts are of that span: from when they left.
    expect(h.state.since.at(-1)).toBe(SINCE);
    // Nothing is opened yet: the round comes on a yes.
    expect(h.homes()).toBe(0);
    await h.answer('yes');
    await settle();
    expect(h.homes()).toBe(1);
  });

  test('with things done and nothing that needs them, the line still has its yes, and the sheet is the receipts alone', async () => {
    const h = harness({ done: 2, waiting: 0, overnight: () => null });
    h.day.morning({ since: SINCE, ms: 14 * 60 * MIN });
    await settle();
    expect(h.said()).toBe('Morning. 2 things done overnight. Nothing needs you.');
    expect(h.line()).toMatchObject({ kind: 'offer', yes: 'show' });
    await h.answer('yes');
    expect(h.said()).toBe('Overnight');
    expect(h.rows()).toEqual(["Getting Sam's answer by Friday", 'Pasted 7 from Notepad into Excel']);
    expect((h.line() as { yes?: string }).yes).toBeUndefined();
    await h.answer('no');
    expect(h.line()).toBeNull();
    expect(h.homes()).toBe(0);
  });

  test('Undo on a receipt takes it back, says so, and the sheet is back without it', async () => {
    const h = harness({ done: 2, waiting: 1, overnight: () => ['Stopped. I will not write to ', { em: 'Sam' }, ' again. What I sent stays sent.'] });
    h.day.morning({ since: SINCE, ms: 14 * 60 * MIN });
    await settle();
    await h.answer('yes');
    await h.answer('button', { button: 'undo', row: 'chase:c1' });
    expect(h.state.undone).toEqual(['chase:c1']);
    expect(h.said()).toBe('Stopped. I will not write to Sam again. What I sent stays sent.');
    await h.answer('done');
    expect(h.said()).toBe('Overnight');
    expect(h.rows()).toEqual(['Pasted 7 from Notepad into Excel', '1 thing needs you.']);
  });

  test('an Undo that takes the notch itself ends the sheet: a paste is taken back in view', async () => {
    const h = harness({ done: 2, waiting: 1, overnight: () => 'left' });
    h.day.morning({ since: SINCE, ms: 14 * 60 * MIN });
    await settle();
    await h.answer('yes');
    await h.answer('button', { button: 'undo', row: 'job:j1' });
    expect(h.state.undone).toEqual(['job:j1']);
    expect(h.line()).toBeNull();
    expect(h.homes()).toBe(0);
  });

  test('a receipt that can no longer be taken back says nothing, and the sheet stays with what stands', async () => {
    const h = harness({ done: 2, waiting: 0, overnight: () => null });
    h.day.morning({ since: SINCE, ms: 14 * 60 * MIN });
    await settle();
    await h.answer('yes');
    await h.answer('button', { button: 'undo', row: 'chase:c1' });
    expect(h.said()).toBe('Overnight');
    // Another button, or one with no row, is nothing.
    await h.answer('button', { button: 'other', row: 'chase:c1' });
    await h.answer('button', { button: 'undo' });
    expect(h.state.undone).toEqual(['chase:c1']);
  });

  test('with nothing done there is nothing to show first: yes goes to what needs them, as before', async () => {
    const h = harness({ done: 0, waiting: 2, overnight: () => null });
    h.day.morning({ since: SINCE, ms: 14 * 60 * MIN });
    await settle();
    expect(h.said()).toBe('Morning. Nothing was done overnight. 2 things need you.');
    await h.answer('yes');
    await settle();
    expect(h.homes()).toBe(1);
    expect(h.state.since).toEqual([]);
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
  // The hardening audit, 17 November 2026: an evening line that could not be
  // said was said the next morning as "Today: 5 things done", counted from
  // yesterday.
  test('one that never got its say is not said the next day', async () => {
    const h = harness({ done: 5, waiting: 2 });
    // Something else has the notch at six, and stays.
    h.inbox.present('other', async (stage) => { await stage.offer(['Something else?'], 'ok', { fold: 0 }); });
    await settle();
    h.state.now = new Date(2026, 10, 16, 18, 5).getTime();
    h.day.tick();
    await settle();
    expect(h.said()).toBe('Something else?');
    // The next morning the notch is free again.
    h.state.now = new Date(2026, 10, 17, 9, 0).getTime();
    await h.answer('no');
    await h.inbox.open();
    await settle();
    expect(h.said()).not.toContain('Today:');
  });

  test('is queued once an evening, however often the clock ticks', async () => {
    const h = harness({ done: 4, waiting: 1 });
    h.inbox.present('other', async (stage) => { await stage.offer(['Something else?'], 'ok', { fold: 0 }); });
    await settle();
    h.state.now = new Date(2026, 10, 16, 18, 5).getTime();
    for (let i = 0; i < 5; i++) { h.day.tick(); h.state.now += MIN; }
    await settle();
    expect(h.inbox.waiting().filter((item) => item.id === 'evening')).toHaveLength(1);
    // Said the same evening once the notch is free.
    await h.answer('no');
    await h.inbox.open();
    await settle();
    expect(h.said()).toBe('Today: 4 things done. 1 still waits.');
  });
});

// The prototype: "1 thing slipped today: Anna's contract. Move it to tomorrow at 9:00?"
describe('what slipped today', () => {
  /** A Monday at 18:30. */
  const EVENING = new Date(2026, 10, 16, 18, 30).getTime();
  const at = (day: number, hour: number, minute = 0): number => new Date(2026, 10, day, hour, minute).getTime();
  const word = (h: ReturnType<typeof harness>): { value: string; options: string[] } => (h.line()!.say.find((part) => typeof part !== 'string' && 'word' in part) as { word: { value: string; options: string[] } }).word;
  const whole = (parts: NotchPart[]): string => parts.map((part) => (typeof part === 'string' ? part : 'em' in part ? part.em : 'word' in part ? `[${part.word.value}]` : '')).join('');

  test('the line names one thing by its words, several by their number, and where to as a word that can be changed', () => {
    const options = ['tomorrow at 9:00', 'Friday at 9:00', 'next week'];
    expect(whole(notchSlippedLine([{ what: "Send Anna the contract." }], 'tomorrow at 9:00', options))).toBe("1 thing slipped today: Send Anna the contract. Move it to [tomorrow at 9:00]?");
    expect(whole(notchSlippedLine([{ what: 'One' }, { what: 'Two' }], 'tomorrow at 9:00', options))).toBe('2 things slipped today. Move them to [tomorrow at 9:00]?');
    const line = notchSlippedLine([{ what: 'x'.repeat(300) }], 'Thursday at 15:00', options);
    expect(whole(line).length).toBeLessThan(140);
    // A time of the owner's own is the first of the choices.
    expect((line.find((part) => typeof part !== 'string' && 'word' in part) as { word: { options: string[]; read?: string } }).word).toMatchObject({ options: ['Thursday at 15:00', ...options], read: 'dayTime' });
  });

  test('a time is the next such moment, on this machine\'s clock', () => {
    expect(notchMoveAt('tomorrow at 9:00', EVENING)).toBe(at(17, 9));
    expect(notchMoveAt('Friday at 9:00', EVENING)).toBe(at(20, 9));
    expect(notchMoveAt(' friday  at 15:30 ', EVENING)).toBe(at(20, 15, 30));
    // The day it is said on means a week on.
    expect(notchMoveAt('Monday at 9:00', EVENING)).toBe(at(23, 9));
    // Next week is its Monday at nine, also when it is said on a Sunday or a Monday.
    expect(notchMoveAt('next week', EVENING)).toBe(at(23, 9));
    expect(notchMoveAt('next week', at(22, 12))).toBe(at(23, 9));
    expect(notchMoveAt('next week', at(18, 12))).toBe(at(23, 9));
    // Today, when the hour is still ahead.
    expect(notchMoveAt('today at 20:00', EVENING)).toBe(at(16, 20));
    expect(notchMoveAt('today at 9:00', EVENING)).toBeNull();
    for (const no of ['', 'soon', 'tomorrow', 'tomorrow at 25:00', 'tomorrow at 9:75', 'Friday', 'in an hour', 'tomorrow at nine']) expect(notchMoveAt(no, EVENING)).toBeNull();
  });

  test('in the evening it is offered before the line that counts the day, and yes moves it', async () => {
    const h = harness({ done: 3, waiting: 0, slipped: [{ id: 'p1', what: "Send Anna the contract" }] });
    h.state.now = EVENING;
    h.day.tick();
    await settle();
    expect(whole(h.line()!.say)).toBe("1 thing slipped today: Send Anna the contract. Move it to [tomorrow at 9:00]?");
    expect(h.line()).toMatchObject({ kind: 'offer', yes: 'move', mood: 'sleepy' });
    expect(word(h).options).toEqual(['tomorrow at 9:00', 'Friday at 9:00', 'next week']);
    // Counted for today: from midnight to now.
    expect(h.state.spans.at(-1)).toEqual([at(16, 0), EVENING]);
    await h.answer('yes');
    expect(h.state.moved).toEqual([{ ids: ['p1'], at: at(17, 9) }]);
    expect(h.said()).toBe('Moved to tomorrow at 9:00.');
    await h.answer('done');
    // Then the day is counted.
    expect(h.said()).toBe('Today: 3 things done. Nothing waits.');
  });

  test('another time can be picked or typed, and that is where it goes', async () => {
    const h = harness({ slipped: [{ id: 'p1', what: 'One' }, { id: 'p2', what: 'Two' }] });
    h.state.now = EVENING;
    h.day.tick();
    await settle();
    expect(whole(h.line()!.say)).toBe('2 things slipped today. Move them to [tomorrow at 9:00]?');
    await h.answer('word', { word: 'when', value: 'Thursday at 15:00' });
    expect(whole(h.line()!.say)).toBe('2 things slipped today. Move them to [Thursday at 15:00]?');
    // What is no time, or not ahead, leaves the word as it was.
    await h.answer('word', { word: 'when', value: 'whenever' });
    await h.answer('word', { word: 'when', value: 'today at 9:00' });
    expect(word(h).value).toBe('Thursday at 15:00');
    await h.answer('yes');
    expect(h.state.moved).toEqual([{ ids: ['p1', 'p2'], at: at(19, 15) }]);
    expect(h.said()).toBe('Moved to Thursday at 15:00.');
  });

  test('on a Thursday the second choice is Monday: tomorrow is Friday already', async () => {
    const h = harness({ slipped: [{ id: 'p1', what: 'One' }] });
    h.state.now = at(19, 18, 30);
    h.day.tick();
    await settle();
    expect(word(h).options).toEqual(['tomorrow at 9:00', 'Monday at 9:00', 'next week']);
  });

  test('Esc moves nothing, and it is not offered again that evening', async () => {
    const h = harness({ slipped: [{ id: 'p1', what: 'One' }] });
    h.state.now = EVENING;
    h.day.tick();
    await settle();
    await h.answer('no');
    expect(h.state.moved).toEqual([]);
    await settle();
    expect(h.said()).toBe('Nothing was done today. Nothing waits.');
    await h.answer('done');
    h.state.now += 10 * MIN;
    h.day.tick();
    await settle();
    expect(h.line()).toBeNull();
  });

  test('with nothing slipped there is only the line that counts the day, and where it cannot be known nothing is offered', async () => {
    for (const options of [{ slipped: [] }, {}]) {
      const h = harness({ done: 1, ...options });
      h.state.now = EVENING;
      h.day.tick();
      await settle();
      expect(h.said()).toBe('Today: 1 thing done. Nothing waits.');
    }
  });

  test('what was kept in the meantime is not offered: it is asked again before the line is shown', async () => {
    const h = harness({ slipped: [{ id: 'p1', what: 'One' }] });
    h.state.now = EVENING;
    h.inbox.present('other', async (stage) => { await stage.say(['Something else.'], 1000); });
    await settle();
    h.day.tick();
    await settle();
    // Opened again in the dashboard while the notch was busy.
    h.state.slipped = [];
    await h.answer('done');
    await settle();
    expect(h.said()).not.toContain('slipped');
  });

  test('when it cannot be moved it says so, and nothing is called moved', async () => {
    const h = harness({ slipped: [{ id: 'p1', what: 'One' }], cannotMove: true });
    h.state.now = EVENING;
    h.day.tick();
    await settle();
    await h.answer('yes');
    expect(h.said()).toBe('I could not move it. It is in the dashboard, as it was.');
  });
});


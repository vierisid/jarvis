import { describe, expect, test } from 'bun:test';
import { NotchInbox } from './inbox.ts';
import type { MailCalendarEvent } from './mail/proposer.ts';
import type { NotchAnswerAct, NotchLine, NotchPart, NotchToPage } from './protocol.ts';
import { NOTCH_SOON_LEAD_MS, attachNotchSoon, notchCalendarChanges, notchMeetings, notchWhenText } from './soon.ts';
import { NOTCH_MESSAGE_EVENT, NotchSurface, type NotchSurfacePort } from './surface.ts';

const MIN = 60_000;
/** A Monday at 14:00, on this machine's clock. */
const NOW = new Date(2026, 10, 16, 14, 0).getTime();
const settle = async (): Promise<void> => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const text = (parts: NotchPart[] | undefined): string => (parts ?? []).map((part) => (typeof part === 'string' ? part : 'em' in part ? part.em : '')).join('');
const event = (summary: string, startInMin: number, minutes = 30, extra: Partial<MailCalendarEvent> = {}): MailCalendarEvent =>
  ({ summary, start: new Date(NOW + startInMin * MIN).toISOString(), end: new Date(NOW + (startInMin + minutes) * MIN).toISOString(), withOthers: true, ...extra });

function harness(events: () => MailCalendarEvent[] | null, options: { maySpeak?: () => boolean; notes?: NonNullable<Parameters<typeof attachNotchSoon>[1]['notes']> } = {}) {
  let onEvent: (sidecarId: string, event: { event_type: string; payload: unknown }) => void = () => {};
  const pushed: NotchToPage[] = [];
  const port: NotchSurfacePort = {
    dispatchRPC(_sidecarId, _method, params) { pushed.push((params as { message: NotchToPage }).message); return Promise.resolve({}); },
    onEvent(listener) { onEvent = listener; },
    onSidecarDisconnected() {},
  };
  const surface = new NotchSurface(port, () => {});
  const fromPage = (message: unknown): void => onEvent('pc', { event_type: NOTCH_MESSAGE_EVENT, payload: { message } });
  fromPage({ type: 'hello', v: 2 });
  const inbox = new NotchInbox(surface, { log: () => {}, maySpeak: options.maySpeak });
  let now = NOW;
  const asked: [number, number][] = [];
  const soon = attachNotchSoon(inbox, { calendar: async (from, to) => { asked.push([from, to]); return events(); }, notes: options.notes, now: () => now, log: () => {} });
  const line = (): NotchLine | null => surface.current().line;
  return {
    soon, inbox, asked, line,
    said: (): string => text(line()?.say),
    count: (): number => surface.current().count,
    pass: (ms: number): void => { now += ms; },
    async answer(act: NotchAnswerAct): Promise<void> { fromPage({ type: 'answer', id: line()!.id, act }); await settle(); },
  };
}

describe('a moment as it is said', () => {
  test('the hour today, "tomorrow at", and the weekday after that', () => {
    expect(notchWhenText(new Date(2026, 10, 16, 16, 0).getTime(), NOW)).toBe('16:00');
    expect(notchWhenText(new Date(2026, 10, 17, 9, 30).getTime(), NOW)).toBe('tomorrow at 09:30');
    expect(notchWhenText(new Date(2026, 10, 19, 10, 0).getTime(), NOW)).toBe('Thursday at 10:00');
  });
});

describe('which events are meetings', () => {
  test('other people are in them and they have hours; the owner\'s own notes and whole days are not', () => {
    const meetings = notchMeetings([
      event('Board call', 60),
      event('Lunch', 30, 60, { withOthers: false }),
      event('Offsite', 0, 24 * 60, { allDay: true }),
      event('  Standup \n with the team ', 10),
      event('', 20),
      { summary: 'Broken', start: 'never', end: 'never', withOthers: true },
    ]);
    expect(meetings.map((meeting) => meeting.title)).toEqual(['Standup with the team', 'Board call']);
  });
});

describe('a meeting coming up', () => {
  test('is said ten minutes before, with the calendar as its source, once', async () => {
    const h = harness(() => [event('Board call', 25)]);
    expect(await h.soon.look()).toBe(true);
    h.soon.tick();
    await settle();
    expect(h.line()).toBeNull();
    h.pass(15 * MIN);
    h.soon.tick();
    await settle();
    expect(h.said()).toBe('Board call in 10 min.');
    expect(h.line()).toMatchObject({ kind: 'say', src: 'cal' });
    await h.answer('done');
    h.pass(MIN);
    h.soon.tick();
    await settle();
    expect(h.line()).toBeNull();
    expect(h.count()).toBe(0);
  });

  // The plan's test: the line arrives only when the hands stop, and typing without a pause delays it.
  test('waits for a still moment, and says how long is left then', async () => {
    let still = false;
    const h = harness(() => [event('Board call', 10)], { maySpeak: () => still });
    await h.soon.look();
    h.soon.tick();
    await settle();
    expect(h.line()).toBeNull();
    expect(h.count()).toBe(1);
    h.pass(4 * MIN);
    still = true;
    h.inbox.calmed();
    await settle();
    expect(h.said()).toBe('Board call in 6 min.');
  });

  test('two minutes before the start it does not wait for a still moment any more', async () => {
    const h = harness(() => [event('Board call', 10)], { maySpeak: () => false });
    await h.soon.look();
    h.soon.tick();
    await settle();
    expect(h.line()).toBeNull();
    h.pass(8 * MIN);
    h.soon.tick();
    await settle();
    expect(h.said()).toBe('Board call in 2 min.');
  });

  test('one that was moved or cancelled in the meantime is not announced at its old hour', async () => {
    let events = [event('Board call', 10)];
    const h = harness(() => events, { maySpeak: () => false });
    await h.soon.look();
    h.soon.tick();
    events = [event('Board call', 90)];
    await h.soon.look();
    await h.inbox.open();
    await settle();
    expect(h.line()).toBeNull();
    expect(h.count()).toBe(0);
  });

  test('a calendar that cannot be reached leaves what was known, and is asked for today and tomorrow', async () => {
    let events: MailCalendarEvent[] | null = [event('Board call', 10)];
    const h = harness(() => events);
    await h.soon.look();
    events = null;
    expect(await h.soon.look()).toBe(false);
    expect(h.soon.ahead().map((meeting) => meeting.title)).toEqual(['Board call']);
    expect(h.asked[0]![1] - h.asked[0]![0]).toBe(37 * 60 * MIN);
  });

  test('knows when a meeting is on now', async () => {
    const h = harness(() => [event('Board call', 5, 30)]);
    await h.soon.look();
    expect(h.soon.meetingNow()).toBe(false);
    h.pass(10 * MIN);
    expect(h.soon.meetingNow()).toBe(true);
    h.pass(30 * MIN);
    expect(h.soon.meetingNow()).toBe(false);
  });

  test('lead time is ten minutes', () => {
    expect(NOTCH_SOON_LEAD_MS).toBe(10 * MIN);
  });
});

describe('what changed in the calendar', () => {
  const meeting = (title: string, startInMin: number) => ({ title, start: NOW + startInMin * MIN, end: NOW + (startInMin + 30) * MIN });

  test('a meeting moved, one added and one cancelled are a sentence each, the soonest first', () => {
    const before = [meeting('Board call', 60), meeting('Standup', 120), meeting('Review', 200)];
    const after = [meeting('Board call', 120), meeting('Standup', 120), meeting('Demo for Lumen', 30)];
    expect(notchCalendarChanges(before, after, NOW).map(text)).toEqual([
      'Demo for Lumen was added, 14:30',
      'Board call moved to 16:00',
      'Review, 17:20, was cancelled',
    ]);
  });

  test('nothing changed is nothing to say, and what is already past is not spoken of', () => {
    const before = [meeting('Standup', -120), meeting('Board call', 60)];
    expect(notchCalendarChanges(before, [meeting('Board call', 60)], NOW)).toEqual([]);
  });

  test('the same title on two days is two meetings: one moving does not look like the other', () => {
    const tomorrow = 24 * 60;
    const before = [meeting('Standup', 60), meeting('Standup', tomorrow + 60)];
    const after = [meeting('Standup', 60), meeting('Standup', tomorrow + 120)];
    expect(notchCalendarChanges(before, after, NOW).map(text)).toEqual(['Standup moved to tomorrow at 16:00']);
  });
});

// The prototype: "Call with Anna in 10 min. Notes are ready."
describe('notes before a meeting', () => {
  const NOTES = { who: 'Anna', blocks: [{ kind: 'row' as const, lead: '28 Oct', say: ['Last call. She liked the workflow demo.'] }, { kind: 'row' as const, lead: 'Waits', say: ['Anna wants the contract to start on 1 December.'] }] };

  test('with something known the line says so, and yes opens it', async () => {
    const seen: { title: string; who?: string[] }[] = [];
    const h = harness(() => [event('Call with Anna', 9, 30, { who: ['Me@northwind.example', 'anna@lumen.example'] })], { notes: (meeting) => { seen.push({ title: meeting.title, who: meeting.who }); return NOTES; } });
    await h.soon.look();
    h.soon.tick();
    await settle();
    expect(h.said()).toBe('Call with Anna in 9 min. Notes are ready.');
    expect(h.line()).toMatchObject({ kind: 'offer', yes: 'show', src: 'cal' });
    // Asked for when the line is said, with the guests the calendar gave, in small letters.
    expect(seen).toEqual([{ title: 'Call with Anna', who: ['me@northwind.example', 'anna@lumen.example'] }]);
    await h.answer('yes');
    expect(h.said()).toBe('Before you talk to Anna');
    expect(h.line()).toMatchObject({ kind: 'sheet', src: 'cal', blocks: NOTES.blocks });
    await h.answer('no');
    expect(h.line()).toBeNull();
  });

  test('with nothing known the line is as it was, and says nothing about notes', async () => {
    for (const notes of [() => null, () => ({ who: 'Anna', blocks: [] }), () => { throw new Error('the mail store is closed'); }]) {
      const h = harness(() => [event('Board call', 9)], { notes });
      await h.soon.look();
      h.soon.tick();
      await settle();
      expect(h.said()).toBe('Board call in 9 min.');
      expect(h.line()).toMatchObject({ kind: 'say' });
    }
  });

  test('Esc on the line is not now: it is said once, and the meeting is not announced again', async () => {
    const h = harness(() => [event('Call with Anna', 9)], { notes: () => NOTES });
    await h.soon.look();
    h.soon.tick();
    await settle();
    await h.answer('no');
    expect(h.line()).toBeNull();
    h.soon.tick();
    await settle();
    expect(h.line()).toBeNull();
    expect(h.count()).toBe(0);
  });

  test('guests are carried only when the calendar gave addresses', () => {
    expect(notchMeetings([event('Sync', 10, 30, { who: ['a@x.example', 'not an address', 7 as never] })])[0]!.who).toEqual(['a@x.example']);
    expect(notchMeetings([event('Sync', 10)])[0]!.who).toBeUndefined();
    expect(notchMeetings([event('Sync', 10, 30, { who: [] })])[0]!.who).toBeUndefined();
  });
});


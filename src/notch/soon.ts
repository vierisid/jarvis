/**
 * The calendar as a source: "Board call in 10 min."
 *
 * A meeting with other people is a running clock. Ten minutes before it
 * starts the notch says so, with the calendar as its source. Like everything
 * that speaks up by itself it waits for a still moment (./inbox.ts), so
 * typing without a pause delays it; two minutes before the start it does not
 * wait any more.
 *
 * Only meetings: an event other people are in. A note of the owner's own in
 * their calendar ("lunch", "focus") is theirs to remember, and whole days are
 * not clocks. The calendar is read the way ./ways.ts says: a connection when
 * there is one, the signed-in browser when not.
 *
 * It says only what is true of the calendar. The prototype's line went on
 * "Notes are ready": nothing prepares notes for a meeting yet, so nothing is
 * said about notes.
 *
 * A title is text from the calendar. It is shown to the person and goes
 * nowhere else from here: no model reads it.
 *
 * This file also remembers what the calendar held when the person went away,
 * and says what changed when they are back (./day.ts asks it).
 */
import type { NotchInbox, NotchItem } from './inbox.ts';
import type { MailCalendarEvent } from './mail/proposer.ts';
import type { NotchPart } from './protocol.ts';

/** How long before a meeting it is said. */
export const NOTCH_SOON_LEAD_MS = 10 * 60 * 1000;
/** From here on it does not wait for a still moment. */
export const NOTCH_SOON_NOW_MS = 2 * 60 * 1000;
/** How far ahead the calendar is kept in mind: today and tomorrow. */
export const NOTCH_SOON_AHEAD_MS = 36 * 60 * 60 * 1000;
/** The most of a title a line carries. */
const TITLE_CHARS = 60;

export interface NotchSoonDeps {
  /** The calendar between two moments, or null when it cannot be reached. */
  calendar(from: number, to: number): Promise<MailCalendarEvent[] | null>;
  now?: () => number;
  log?: (line: string) => void;
}

/** A meeting as this file keeps it. */
export interface NotchMeeting { title: string; start: number; end: number }

export interface NotchSoon {
  /** Reads the calendar. False when it could not be reached: what was known stays. */
  look(): Promise<boolean>;
  /** Puts on the notch what is ten minutes away. Called every half minute. */
  tick(): void;
  /** Whether a meeting is on now. */
  meetingNow(): boolean;
  /** The meetings ahead, as last read. */
  ahead(): NotchMeeting[];
}

const em = (text: string): NotchPart => ({ em: text });
const oneLine = (text: string): string => { const points = [...text.replace(/\s+/g, ' ').trim()]; return points.length <= TITLE_CHARS ? points.join('') : `${points.slice(0, TITLE_CHARS - 1).join('').trimEnd()}…`; };
const two = (n: number): string => String(n).padStart(2, '0');

/** "16:00", "tomorrow at 09:30", "Thursday at 10:00": a moment as it is said from `now`. */
export function notchWhenText(at: number, now: number): string {
  const day = new Date(at);
  const clock = `${two(day.getHours())}:${two(day.getMinutes())}`;
  const midnight = (moment: number): number => { const d = new Date(moment); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const days = Math.round((midnight(at) - midnight(now)) / (24 * 60 * 60 * 1000));
  if (days === 0) return clock;
  if (days === 1) return `tomorrow at ${clock}`;
  return `${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][day.getDay()]} at ${clock}`;
}

/** The meetings among some events: other people are in them, and they have hours. */
export function notchMeetings(events: MailCalendarEvent[]): NotchMeeting[] {
  const meetings: NotchMeeting[] = [];
  for (const event of events) {
    const start = Date.parse(event.start);
    const end = Date.parse(event.end);
    const title = oneLine(event.summary);
    if (!event.withOthers || event.allDay || !title || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    meetings.push({ title, start, end });
  }
  return meetings.sort((a, b) => a.start - b.start);
}

/**
 * What changed between two readings of the calendar, for the meetings still
 * ahead: one sentence each, the soonest first. A meeting is the same one when
 * it has the same title on the same day; with another start it has moved.
 */
export function notchCalendarChanges(before: NotchMeeting[], after: NotchMeeting[], now: number): NotchPart[][] {
  const dayKey = (meeting: NotchMeeting): string => `${meeting.title}|${new Date(meeting.start).toDateString()}`;
  const was = before.filter((meeting) => meeting.start > now);
  const is = after.filter((meeting) => meeting.start > now);
  const changes: { at: number; say: NotchPart[] }[] = [];
  const leftOver = [...was];
  for (const meeting of is) {
    const same = leftOver.findIndex((other) => other.title === meeting.title && other.start === meeting.start);
    if (same >= 0) { leftOver.splice(same, 1); continue; }
    const moved = leftOver.findIndex((other) => dayKey(other) === dayKey(meeting));
    if (moved >= 0) {
      leftOver.splice(moved, 1);
      changes.push({ at: meeting.start, say: [em(meeting.title), ' moved to ', em(notchWhenText(meeting.start, now))] });
    } else {
      changes.push({ at: meeting.start, say: [em(meeting.title), ' was added, ', em(notchWhenText(meeting.start, now))] });
    }
  }
  for (const gone of leftOver) changes.push({ at: gone.start, say: [em(gone.title), ', ', notchWhenText(gone.start, now), ', was cancelled'] });
  return changes.sort((a, b) => a.at - b.at).map((change) => change.say);
}

export function attachNotchSoon(inbox: NotchInbox, deps: NotchSoonDeps): NotchSoon {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.log(line));
  let meetings: NotchMeeting[] = [];
  /** Meetings that have been put on the notch, by start and title: `said` once it was on screen. */
  const put = new Map<string, { urgent: boolean; said: boolean }>();
  const keyOf = (meeting: NotchMeeting): string => `${meeting.start}|${meeting.title}`;

  const item = (meeting: NotchMeeting, urgent: boolean): NotchItem => {
    const key = keyOf(meeting);
    return {
      id: `soon:${key}`,
      subject: `soon:${key}`,
      class: 'clock',
      speaks: true,
      once: true,
      ...(urgent ? { urgent: true } : {}),
      title: () => [em(meeting.title), ` at ${notchWhenText(meeting.start, now())}`],
      // Still to come, or only just begun. One that is no longer in the calendar at that hour is not announced.
      check: () => now() < meeting.start + 60_000 && meetings.some((other) => keyOf(other) === key),
      play: async (stage) => {
        const state = put.get(key);
        if (state) state.said = true;
        const minutes = Math.round((meeting.start - now()) / 60_000);
        await stage.say(minutes >= 1 ? [em(meeting.title), ' in ', em(`${minutes} min`), '.'] : [em(meeting.title), ' is starting now.'], 6000, { src: 'cal', mood: 'look' });
        return 'settled';
      },
    };
  };

  return {
    async look() {
      const at = now();
      let events: MailCalendarEvent[] | null = null;
      try {
        events = await deps.calendar(at - 60 * 60 * 1000, at + NOTCH_SOON_AHEAD_MS);
      } catch (error) {
        log(`[notch] the calendar could not be read: ${error instanceof Error ? error.message.slice(0, 160) : 'no answer'}`);
      }
      if (!events) return false;
      meetings = notchMeetings(events);
      // What is long over need not be remembered as said.
      for (const key of [...put.keys()]) if (Number(key.split('|')[0]) < at - 60 * 60 * 1000) put.delete(key);
      return true;
    },
    tick() {
      const at = now();
      for (const meeting of meetings) {
        const left = meeting.start - at;
        if (left <= 0 || left > NOTCH_SOON_LEAD_MS) continue;
        const key = keyOf(meeting);
        const state = put.get(key);
        const urgent = left <= NOTCH_SOON_NOW_MS;
        if (!state) { put.set(key, { urgent, said: false }); inbox.add(item(meeting, urgent)); continue; }
        // Ten minutes ago it joined the count because the person was typing, and they still are: it does not wait any more.
        if (urgent && !state.urgent && !state.said && inbox.has(`soon:${key}`)) { state.urgent = true; inbox.add(item(meeting, true)); }
      }
    },
    meetingNow: () => { const at = now(); return meetings.some((meeting) => meeting.start <= at && at < meeting.end); },
    ahead: () => meetings.filter((meeting) => meeting.start > now()),
  };
}

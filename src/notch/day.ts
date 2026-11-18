/**
 * The shape of the day: the morning line, the evening line, and what changed
 * while the person was away.
 *
 * Three lines, each said once, each made of numbers that are counted at the
 * moment it is said and of nothing else:
 *
 *   morning   the first time they are there today: what was done overnight,
 *             and how many things need them. Yes opens "Overnight": the
 *             receipts of what was done, each with Undo where it can be
 *             taken back, and from there the things that need them
 *   back      after twenty minutes away: who wrote and is waiting, and what
 *             moved in the calendar. Said only when it is more than one new
 *             mail: one new mail is its own line and needs no summary
 *   evening   from six in the evening, if they are there: what was done today
 *             and what still waits. And when something that was promised
 *             for today was not kept, the prototype's line before it: "1
 *             thing slipped today: ... Move it to tomorrow at 9:00?" A yes
 *             opens it again and re-dates it, the way the dashboard does
 *
 * Each waits for a still moment like everything that speaks up by itself.
 * When a line has told of replies that wait, those are told: they do not each
 * speak up again after it, and are one step away in Home.
 */
import type { NotchInbox, NotchItem, NotchItemEnd } from './inbox.ts';
import { notchDayOf } from './presence.ts';
import type { NotchBlock, NotchPart } from './protocol.ts';
import type { NotchSettings } from './settings.ts';
import { notchCalendarChanges, type NotchMeeting } from './soon.ts';
import type { NotchStage } from './stage.ts';

/** The hour from which the evening line may be said, on this machine's clock. */
export const NOTCH_EVENING_HOUR = 18;
/** When nothing is known of when they left, "overnight" is this long. */
export const NOTCH_OVERNIGHT_MS = 12 * 60 * 60 * 1000;

export interface NotchDayDeps {
  settings: NotchSettings;
  /** How many things were done between two moments: actions carried out, promises kept, replies sent. */
  done(since: number, until: number): number;
  /** How many things wait for the person's word now, replies that are drafted included. */
  waiting(): number;
  /** The morning line is on the notch: whoever keeps the day of the last one writes it down (./presence.ts). */
  morningSaid?: () => void;
  /**
   * What the morning line opens when something was done while they were
   * away: the receipts of it, each with Undo where it can be taken back
   * (./today.ts). `undo` takes one back by its row: it comes back with what
   * to say, with null when there is nothing to say, or with `left` when the
   * taking back has taken the notch itself (a paste is undone in view).
   */
  overnight?: {
    blocks(since: number): NotchBlock[];
    undo(row: string): NotchPart[] | null | 'left';
  };
  /** Whether the person is away now: the evening line is not said to an empty chair. */
  away?(): boolean;
  mail?: {
    /** Replies prepared since a moment that the owner has not seen. */
    newSince(at: number): number;
    /** Those have been told of: they do not each speak up after this. */
    told(): void;
    /** The reply, or the list of them. */
    open(stage: NotchStage): Promise<void>;
  };
  calendar?: {
    ahead(): NotchMeeting[];
    look(): Promise<boolean>;
  };
  /**
   * What was promised for today and was not kept: the evening offers to move
   * it. `today` gives those between two moments. `move` opens them again
   * with a new due time, and says how many it moved. Which promises may be
   * opened again is the source's to say: one that may have partly run is not
   * among them.
   */
  slipped?: {
    today(since: number, until: number): { id: string; what: string }[];
    move(ids: string[], at: number): number;
  };
  now?: () => number;
  log?: (line: string) => void;
}

export interface NotchDay {
  /** The first time they are there today (./presence.ts). */
  morning(away: { since: number | null; ms: number }): void;
  /** They have been away for twenty minutes: what the calendar holds now is kept, to tell what changes. */
  left(at: number): void;
  /** They are back. */
  back(away: { since: number; ms: number }): Promise<void>;
  /** Called every minute: the evening line, when its hour has come. */
  tick(): void;
}

const em = (text: string): NotchPart => ({ em: text });
const things = (n: number): string => (n === 1 ? '1 thing' : `${n} things`);
const EVENING = 'day.evening';

/** The morning line, from its two numbers. */
export function notchMorningLine(done: number, waiting: number): NotchPart[] {
  if (done === 0 && waiting === 0) return ['Morning. Nothing happened overnight, and nothing needs you.'];
  const first: NotchPart[] = done > 0 ? ['Morning. ', em(things(done)), ' done overnight. '] : ['Morning. Nothing was done overnight. '];
  const second: NotchPart[] = waiting === 0 ? ['Nothing needs you.'] : done > 0 ? [em(String(waiting)), waiting === 1 ? ' needs you.' : ' need you.'] : [em(things(waiting)), waiting === 1 ? ' needs you.' : ' need you.'];
  return [...first, ...second];
}

/** The evening line, from its two numbers. */
export function notchEveningLine(done: number, waiting: number): NotchPart[] {
  const first: NotchPart[] = done > 0 ? ['Today: ', em(things(done)), ' done. '] : ['Nothing was done today. '];
  const second: NotchPart[] = waiting === 0 ? ['Nothing waits.'] : [em(String(waiting)), waiting === 1 ? ' still waits.' : ' still wait.'];
  return [...first, ...second];
}

/** The times the evening offers to move a thing to. */
export const NOTCH_MOVE_TO = ['tomorrow at 9:00', 'Friday at 9:00', 'next week'] as const;
/** The most of a slipped thing's words the line carries. */
const SLIPPED_CHARS = 60;

/**
 * The moment a time is, as the evening's word says it: "tomorrow at 9:00",
 * "Friday at 15:30", "today at 20:00", "next week" (Monday at nine). The next
 * such moment after `now`, on this machine's clock. Null when the words are
 * no such time, or the moment is not ahead.
 */
export function notchMoveAt(value: string, now: number): number | null {
  const said = value.trim().toLowerCase().replace(/\s+/g, ' ');
  const at = new Date(now);
  const set = (days: number, hour: number, minute: number): number => { const d = new Date(now); d.setDate(d.getDate() + days); d.setHours(hour, minute, 0, 0); return d.getTime(); };
  if (said === 'next week') return set(((8 - at.getDay()) % 7) || 7, 9, 0);
  const parts = /^(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday) at (\d{1,2}):(\d{2})$/.exec(said);
  if (!parts) return null;
  const hour = Number(parts[2]), minute = Number(parts[3]);
  if (hour > 23 || minute > 59) return null;
  let days = 0;
  if (parts[1] === 'tomorrow') days = 1;
  else if (parts[1] !== 'today') {
    const wanted = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].indexOf(parts[1]!);
    // The next such day: a day named on that day itself means a week on.
    days = ((wanted - at.getDay() + 7) % 7) || 7;
  }
  const moment = set(days, hour, minute);
  return moment > now ? moment : null;
}

/** The line about what slipped: one thing by its words, several by their number, and where to as a word that can be changed. */
export function notchSlippedLine(things: readonly { what: string }[], when: string, options: readonly string[]): NotchPart[] {
  const word: NotchPart = { word: { name: 'when', value: when, options: options.includes(when) ? [...options] : [when, ...options], label: 'Move to', read: 'dayTime' } };
  const [only] = things;
  if (things.length === 1 && only) {
    const points = [...only.what.replace(/\s+/g, ' ').trim().replace(/[.!?]+$/, '')];
    const what = points.length <= SLIPPED_CHARS ? points.join('') : `${points.slice(0, SLIPPED_CHARS - 1).join('').trimEnd()}…`;
    return [em('1 thing'), ' slipped today: ', what, '. Move it to ', word, '?'];
  }
  return [em(`${things.length} things`), ' slipped today. Move them to ', word, '?'];
}

/** What changed while they were away, as one sentence. Null when it is not worth a line. */
export function notchBackLine(mail: number, calendar: NotchPart[][]): NotchPart[] | null {
  // One new mail is its own line ("In Gmail: you have not replied to Marco"): it needs no summary.
  if (mail <= 1 && calendar.length === 0) return null;
  const parts: NotchPart[] = ['While you were away: '];
  if (mail > 0) parts.push(em(mail === 1 ? '1 person' : `${mail} people`), mail === 1 ? ' wrote and is waiting for a reply' : ' wrote and are waiting for a reply');
  if (calendar.length > 0) {
    if (mail > 0) parts.push(', and ');
    parts.push(...calendar[0]!);
    if (calendar.length > 1) parts.push(', and ', em(calendar.length === 2 ? '1 more change' : `${calendar.length - 1} more changes`), ' in your calendar');
  }
  parts.push('.');
  return parts;
}

export function attachNotchDay(inbox: NotchInbox, deps: NotchDayDeps): NotchDay {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.log(line));
  /** What the calendar held when they went away. Null when they are not away, or it was not known. */
  let before: NotchMeeting[] | null = null;
  /** The day whose evening line is in the inbox, said or not. */
  let eveningQueued = '';

  /** A line that is news, said once. With `show`, yes opens what it spoke of. */
  const line = (id: string, cls: NotchItem['class'], say: () => NotchPart[] | null, options: {
    mood?: 'happy' | 'sleepy' | 'idle'; show?: (stage: NotchStage) => Promise<void> | void; ms?: number; told?: () => void; said?: () => void;
    /** Something that is asked before the line is said: the evening's offer to move what slipped. */
    before?: (stage: NotchStage) => Promise<void>;
  } = {}): NotchItem => ({
    id,
    subject: id,
    class: cls,
    speaks: true,
    once: true,
    title: () => say() ?? [],
    check: () => say() !== null,
    play: async (stage): Promise<NotchItemEnd> => {
      const words = say();
      if (!words) return 'settled';
      options.told?.();
      // It is on the notch: written down as said now, and not when it was queued.
      options.said?.();
      if (options.before) await options.before(stage);
      if (!options.show) {
        await stage.say(words, options.ms ?? 5200, { mood: options.mood ?? 'idle', comes: 'pair' });
        return 'settled';
      }
      const answer = await stage.offer(words, 'show', { mood: options.mood ?? 'idle', comes: 'pair' });
      if (answer.act === 'yes') await options.show(stage);
      return 'settled';
    },
  });

  return {
    morning(away) {
      const since = away.since ?? now() - NOTCH_OVERNIGHT_MS;
      const counts = (): [number, number] => [deps.done(since, now()), deps.waiting()];
      // What the round shows is what "need you" counted: a tap on the notch, once this line has ended.
      const show = (): void => { setTimeout(() => inbox.open(), 0); };
      const [done, waiting] = counts();
      log('[notch] the first time today: the morning line');
      // A morning line is for its morning: one that never got its say is not said the day after.
      const day = notchDayOf(now());
      /**
       * "Overnight" (the prototype's sheet): what was done, as receipts with
       * Undo, and how many things need them. Yes goes on to those. With
       * nothing done there is nothing to show before them, and yes goes
       * straight to the round, as it did.
       */
      const overnight = deps.overnight;
      const sheet = overnight && done > 0 ? async (stage: NotchStage): Promise<void> => {
        const id = stage.id();
        const needs = (): number => deps.waiting();
        const blocks = (): NotchBlock[] => {
          const k = needs();
          return [...overnight.blocks(since), ...(k > 0 ? [{ kind: 'note' as const, say: [em(things(k)), k === 1 ? ' needs you.' : ' need you.'] }] : [])];
        };
        stage.put({ id, kind: 'sheet', say: ['Overnight'], blocks: blocks(), mood: 'look', ...(needs() > 0 ? { yes: 'show', stay: true } : {}) });
        for (;;) {
          const answer = await stage.answer(id, ['yes', 'no', 'button']);
          if (answer.act === 'no') return;
          if (answer.act === 'yes') { if (needs() > 0) show(); return; }
          if (answer.button !== 'undo' || !answer.row) continue;
          const said = overnight.undo(answer.row);
          // The taking back has the notch from here: it shows itself.
          if (said === 'left') return;
          if (said) {
            await stage.say(said, 3400, { mark: 'check' });
            stage.put({ id, kind: 'sheet', say: ['Overnight'], blocks: blocks(), mood: 'look', ...(needs() > 0 ? { yes: 'show', stay: true } : {}) });
          } else {
            stage.surface.update(id, { blocks: blocks() });
          }
        }
      } : null;
      inbox.add(line('morning', 'rest', () => (notchDayOf(now()) === day ? notchMorningLine(...counts()) : null),
        { mood: 'happy', told: deps.mail?.told, said: deps.morningSaid, ...(sheet ? { show: sheet } : waiting > 0 ? { show } : {}) }));
    },
    left() {
      before = deps.calendar ? [...deps.calendar.ahead()] : null;
    },
    async back(away) {
      const kept = before;
      before = null;
      let changes: NotchPart[][] = [];
      if (kept && deps.calendar) {
        const read = await deps.calendar.look().catch(() => false);
        // A calendar that could not be read now has not changed as far as anyone knows.
        if (read) changes = notchCalendarChanges(kept, deps.calendar.ahead(), now());
      }
      const mail = deps.mail?.newSince(away.since) ?? 0;
      if (!notchBackLine(mail, changes)) return;
      const told = mail > 0 ? deps.mail!.told : undefined;
      // Counted again when it is said: a reply answered in the meantime is not spoken of.
      const words = (): NotchPart[] | null => notchBackLine(told ? Math.max(deps.mail!.newSince(away.since), 0) : 0, changes);
      inbox.add(line('back', mail > 0 ? 'person' : 'rest', words, { told, ...(mail > 0 ? { show: (stage: NotchStage) => deps.mail!.open(stage) } : {}), ms: 6400 }));
    },
    tick() {
      const at = now();
      const today = notchDayOf(at);
      if (new Date(at).getHours() < NOTCH_EVENING_HOUR || deps.settings.get<string>(EVENING, '') === today || eveningQueued === today || deps.away?.()) return;
      // Queued once a day, and written down when it has been said: written
      // down here, a brain that restarted before the line got its still
      // moment said no evening line that day.
      eveningQueued = today;
      const start = new Date(at);
      start.setHours(0, 0, 0, 0);
      // The prototype's evening: what was promised for today and was not kept, with the way to move it.
      // Asked first, on the same turn of the notch, and then the day is counted: a second line of its own
      // would have waited in the count and said nothing.
      const slipped = deps.slipped;
      const still = (): { id: string; what: string }[] => { try { return slipped && notchDayOf(now()) === today ? slipped.today(start.getTime(), now()) : []; } catch { return []; } };
      // The Friday of the choices is not tomorrow said twice: on a Thursday it is Monday.
      const options = NOTCH_MOVE_TO.map((one) => (one === 'Friday at 9:00' && new Date(at).getDay() === 4 ? 'Monday at 9:00' : one));
      const move = slipped ? async (stage: NotchStage): Promise<void> => {
        // Counted now, not when the evening began: what was opened again in the meantime has not slipped.
        if (still().length === 0) return;
        let when: string = options[0]!;
        const id = stage.id();
        stage.put({ id, kind: 'offer', say: notchSlippedLine(still(), when, options), yes: 'move', mood: 'sleepy', comes: 'pair' });
        for (;;) {
          const answer = await stage.answer(id, ['yes', 'no', 'fold', 'word']);
          if (answer.act === 'word') {
            // A time that is one, and ahead: any other leaves the word as it was.
            const typed = (answer.value ?? '').trim();
            if (answer.word === 'when' && notchMoveAt(typed, now()) !== null) when = typed;
            stage.surface.update(id, { say: notchSlippedLine(still(), when, options) });
            continue;
          }
          if (answer.act !== 'yes') return;
          const to = notchMoveAt(when, now());
          const things = still();
          let moved = 0;
          try { moved = to === null ? 0 : slipped.move(things.map((one) => one.id), to); } catch { moved = 0; }
          log(`[notch] what slipped today was moved: ${moved} of ${things.length}`);
          await stage.say(moved > 0 ? ['Moved to ', em(when), '.'] : ['I could not move it. It is in the dashboard, as it was.'], moved > 0 ? 2800 : 4200,
            moved > 0 ? { mood: 'sleepy', mark: 'check' } : { mood: 'sorry', mark: 'fail' });
          return;
        }
      } : undefined;
      // The line that counts the day. It is for its evening: one that could not be said (no notch was up) was
      // said the next morning as "Today: 5 things done", counted from yesterday.
      inbox.add(line('evening', 'rest', () => (notchDayOf(now()) === today ? notchEveningLine(deps.done(start.getTime(), now()), deps.waiting()) : null),
        { mood: 'sleepy', said: () => deps.settings.set(EVENING, today, now()), before: move }));
    },
  };
}

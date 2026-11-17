/**
 * The shape of the day: the morning line, the evening line, and what changed
 * while the person was away.
 *
 * Three lines, each said once, each made of numbers that are counted at the
 * moment it is said and of nothing else:
 *
 *   morning   the first time they are there today: what was done overnight,
 *             and how many things need them
 *   back      after twenty minutes away: who wrote and is waiting, and what
 *             moved in the calendar. Said only when it is more than one new
 *             mail: one new mail is its own line and needs no summary
 *   evening   from six in the evening, if they are there: what was done today
 *             and what still waits
 *
 * Each waits for a still moment like everything that speaks up by itself.
 * When a line has told of replies that wait, those are told: they do not each
 * speak up again after it, and are one step away in Home.
 */
import type { NotchInbox, NotchItem, NotchItemEnd } from './inbox.ts';
import { notchDayOf } from './presence.ts';
import type { NotchPart } from './protocol.ts';
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

  /** A line that is news, said once. With `show`, yes opens what it spoke of. */
  const line = (id: string, cls: NotchItem['class'], say: () => NotchPart[] | null, options: { mood?: 'happy' | 'sleepy' | 'idle'; show?: (stage: NotchStage) => Promise<void> | void; ms?: number; told?: () => void } = {}): NotchItem => ({
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
      const [, waiting] = counts();
      log('[notch] the first time today: the morning line');
      inbox.add(line('morning', 'rest', () => notchMorningLine(...counts()), { mood: 'happy', told: deps.mail?.told, ...(waiting > 0 ? { show } : {}) }));
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
      if (new Date(at).getHours() < NOTCH_EVENING_HOUR || deps.settings.get<string>(EVENING, '') === today || deps.away?.()) return;
      deps.settings.set(EVENING, today, at);
      const start = new Date(at);
      start.setHours(0, 0, 0, 0);
      inbox.add(line('evening', 'rest', () => notchEveningLine(deps.done(start.getTime(), now()), deps.waiting()), { mood: 'sleepy' }));
    },
  };
}

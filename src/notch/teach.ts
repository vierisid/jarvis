/**
 * Teaching Jarvis a job by showing it: "Watch me", then "done" (pass 10).
 *
 * Saying "Watch me" starts the product's own recorder on the person's
 * machine (src/skills/recorder.ts). Saying it is the permission: on the
 * notch there is no card to click first. For as long as it watches, the
 * notch says so and counts the steps it saw. Yes, or the word "done", ends
 * it; Esc throws it away. What was shown is saved as a skill, signed like any
 * other, and is then one of two things:
 *
 *   - the same few steps done twice, one place further along (./rounds.ts):
 *     Jarvis offers to go on from there, as it does when it catches such a
 *     job by itself.
 *   - anything else: a job it can do again as it was shown, when asked ("run
 *     it"), or at a time of the week. At that time it asks first, on the
 *     notch, and does it on a yes: a job that drives the person's screen does
 *     not start while nobody is looking.
 *
 * A job that pays for something is never run from here. A job that deletes
 * something asks once before it runs.
 */
import type { Database } from 'bun:sqlite';
import type { RawInteraction } from '../skills/recorder.ts';
import type { NotchCatch } from './catch.ts';
import { countRequest } from './catch.ts';
import type { NotchInbox } from './inbox.ts';
import {
  NOTCH_ROWS_NOT_SEEN, newPlacedRun, newRoundsRun, roundsPlan, roundsWords, runPlaced, sureRounds,
  type PlacedStep,
  type NotchJobEnd, type NotchJobHands, type NotchJobPlan, type NotchJobs, type NotchRunOptions,
} from './jobs.ts';
import type { NotchBlock, NotchPart, NotchWord } from './protocol.ts';
import { findRounds, roundsApps, roundsCopy, roundsToDo, watchKeysOk, type Rounds, type WatchStep } from './rounds.ts';
import { NotchStageEnded, type NotchStage } from './stage.ts';
import { routeByIntents, type NotchIntent } from './intents.ts';

/** How long a teaching may last. The desktop app takes its hooks out at the same time by itself. */
export const NOTCH_TEACH_MAX_MS = 10 * 60_000;
/** How long after its time a job is still offered. Later than that, the time was missed and it waits for the next. */
export const NOTCH_SCHEDULE_LATE_MS = 30 * 60_000;
/** How long the rounds of a teaching are still where to go on from. */
export const NOTCH_TEACH_FRESH_MS = 3 * 60_000;
export const NOTCH_SCHEDULES = ['Monday at 9:00', 'Monday at 14:00', 'Friday at 16:00', 'day at 9:00'];

const em = (text: string): NotchPart => ({ em: text });
const word = (name: string, value: string, options: string[], more: Partial<NotchWord> = {}): NotchPart =>
  ({ word: { name, value, options, ...more } });

const LEAD = '(?:(?:ok(?:ay)?|hey|jarvis|please|now|so)[,\\s]+)*';

/** "Watch me", "watch this", "let me show you": the person is about to show a job. */
export function watchMeRequest(text: string): boolean {
  const said = text.trim();
  if (said.split(/\s+/).length > 14) return false;
  return new RegExp(`^${LEAD}watch me\\b`, 'i').test(said)
    || new RegExp(`^${LEAD}(?:watch (?:this|what i do|how i do (?:it|this))|let me show you|i(?:'ll| will) show you|learn this|guardami|ti faccio vedere|ti mostro)\\b[\\s,.!]*(?:how\\b.*)?$`, 'i').test(said);
}

/** "Done", "that's it": the showing is over. */
export function teachDoneWord(text: string): boolean {
  return new RegExp(`^${LEAD}(?:done|i'?m done|i am done|that'?s (?:it|all)|that is (?:it|all)|finished|fatto|finito|stop watching)[\\s.!]*$`, 'i').test(text.trim());
}

const NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  a: 1, an: 1, another: 1, once: 1, twice: 2,
};

/** What a sentence that asks for the job begins with. What may come after it is `RUN_TAIL`. */
const RUN_HEADS = [
  /^(?:run|do|repeat|redo) (?:it|that|this|the same|them)\b/,
  /^(?:do|finish|run) the (?:rest|others?|remaining|next)\b/,
  /^(?:finish|continue) (?:it|them|that)\b/,
  /^(?:take it from here|take over|keep going|go on|continue|carry on)\b/,
  /^(?:fai|finisci) (?:il resto|gli altri|le altre)\b/,
];
/** "Do 3 more", "run another more": the job with nothing but a count. */
const RUN_MORE = /^(?:do|run)(?= (?:\S+ )?more\b)/;

/** A count as it is said: digits, or a word for a number. Not "a" and "an", which are in too many sentences. */
const RUN_NUM = `(?:\\d{1,3}|${Object.keys(NUMBERS).filter((word) => word !== 'a' && word !== 'an').join('|')})`;
const RUN_UNIT = '(?:rows?|lines?|cells?|columns?|items?|entries|entry|records?|ones?|times?)';
const RUN_COUNT = `(?:(?:the |these |those )?(?:next |other |remaining )?${RUN_NUM}(?: more)?(?: ${RUN_UNIT})?|(?:some |a few )?more(?: ${RUN_UNIT})?)`;
const RUN_SPAN = `(?:(?:on|for) (?:all(?: of them| (?:the |these |those )?${RUN_UNIT})?|(?:the |these |those )?(?:next |other |remaining )?${RUN_NUM}(?: more)?(?: ${RUN_UNIT})?))`;

/**
 * What may come after "do it": how many, of what, again, and a please. Nothing else. "Do it by email", "do it
 * for me", "do the same for the other file", "finish it by Friday" and "continue with the draft to Sam" each
 * say something that is not about the job, and are an instruction like any other.
 */
const RUN_TAIL = new RegExp(`^(?: ${RUN_COUNT})?(?: ${RUN_SPAN})?(?: (?:again|once more|one more time))?(?:,? (?:please|now|thanks|thank you|per favore))*$`);

/** What is left of a sentence when the words before it ("ok", "Jarvis,") are taken off. */
const runRest = (text: string): string => text.trim().toLowerCase().replace(/[.!?]+$/, '').replace(/\s+/g, ' ').replace(new RegExp(`^${LEAD}`, 'i'), '');

/**
 * Whether a sentence begins with the words that ask for the job, whatever follows them: "do it at 5",
 * "continue with the draft to Sam", "do 3 more". Such a sentence is the job when nothing else is in it
 * (`runItRequest`), and otherwise an instruction. It is never a new value for a word of the line that is up
 * (./said.ts), and with a job that was shown it is not read for whom it names (./real.ts, `notchRead`).
 */
export function runItBegins(text: string): boolean {
  const rest = runRest(text);
  return RUN_HEADS.some((head) => head.test(rest)) || RUN_MORE.test(rest);
}

/**
 * "Run it on nine rows", "do the rest", "do it again", "take it from here":
 * the last job that was shown, or begun by hand, is to be done. `count` is
 * how many, when a number was said.
 *
 * These words are the whole of the sentence. They used to be its beginning:
 * anything that began "do it", "continue" or "finish it" was the job, and
 * with one job ever shown "do it by email" replayed its clicks and keys
 * (docs/notch/fixes/03-intent-routing.md). A comma, or a word that is not
 * about the job, makes the sentence an instruction like any other.
 */
export function runItRequest(text: string): { count: number | null } | null {
  const rest = runRest(text);
  if (!rest || rest.split(' ').length > 12) return null;
  const head = [...RUN_HEADS, RUN_MORE].map((one) => one.exec(rest)).find((found) => found !== null);
  if (!head || !RUN_TAIL.test(rest.slice(head[0].length))) return null;
  const digits = /\b(\d{1,3})\b/.exec(rest);
  if (digits) return { count: Math.max(1, Number(digits[1])) };
  for (const part of rest.split(/[\s-]+/)) {
    // "a" and "an" count only before "more" or "time": "do it on a row" is not a count worth guessing.
    if ((part === 'a' || part === 'an') && !/\b(?:a|an) (?:more|time|few)\b/.test(rest)) continue;
    if (Object.hasOwn(NUMBERS, part)) return { count: NUMBERS[part]! };
  }
  return { count: null };
}

/** "Undo", "undo that", "take it back": the last thing Jarvis pasted is taken back. */
export function undoRequest(text: string): boolean {
  return new RegExp(`^${LEAD}(?:undo|take (?:it|that) back|annulla)(?: (?:it|that|this|the paste|my paste|your paste|the last (?:one|thing|paste)))?[\\s.!]*$`, 'i').test(text.trim());
}

/** When a job is done by the week: on one day, or every day, at a time. */
export interface NotchSchedule { day: number | null; hour: number; minute: number }

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** Reads "Monday at 9:00" and "day at 9:00", as the notch's lit word writes them. */
export function parseSchedule(text: string): NotchSchedule | null {
  const found = /^\s*([a-z]+) at (\d{1,2})[:.](\d{2})\s*$/i.exec(text);
  if (!found) return null;
  const name = found[1]!.toLowerCase();
  const hour = Number(found[2]);
  const minute = Number(found[3]);
  if (hour > 23 || minute > 59) return null;
  if (name === 'day') return { day: null, hour, minute };
  const day = DAYS.indexOf(name);
  return day < 0 ? null : { day, hour, minute };
}

/** The next time after `after`, on this machine's clock. */
export function nextScheduled(schedule: NotchSchedule, after: number): number {
  const at = new Date(after);
  at.setSeconds(0, 0);
  at.setHours(schedule.hour, schedule.minute);
  for (let tries = 0; tries < 9; tries++) {
    if (at.getTime() > after && (schedule.day === null || at.getDay() === schedule.day)) return at.getTime();
    at.setDate(at.getDate() + 1);
    at.setHours(schedule.hour, schedule.minute, 0, 0);
  }
  return at.getTime();
}

/** How a shortcut is said: "Ctrl + C", "Enter". */
export function keysSaid(keys: string): string {
  const names: Record<string, string> = {
    ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', win: 'Win', cmd: 'Cmd', enter: 'Enter', tab: 'Tab', delete: 'Delete', insert: 'Insert',
    pageup: 'Page Up', pagedown: 'Page Down', end: 'End', home: 'Home', left: 'Left', up: 'Up', right: 'Right', down: 'Down',
    backspace: 'Backspace', space: 'Space',
  };
  return keys.split(',').map((part) => names[part] ?? part.toUpperCase()).join(' + ');
}

const short = (text: string, max: number): string => {
  const one = text.replace(/\s+/g, ' ').trim();
  return [...one].length <= max ? one : `${[...one].slice(0, max - 1).join('').trimEnd()}…`;
};

/** One step of a showing, as the notch says it while it watches. */
export function teachStepSaid(interaction: RawInteraction): string {
  const name = short(interaction.ref?.name ?? '', 40);
  switch (interaction.action) {
    case 'click': return name ? `clicked ${name}` : 'a click';
    case 'set_value': return name ? `typed into ${name}` : 'typed into a field';
    case 'press_keys': return `pressed ${keysSaid(interaction.value ?? '')}`;
    case 'launch_app': return 'opened an app';
    default: return 'opened a page';
  }
}

/** What was shown, as shapes: for telling whether it was the same thing done twice. */
export function teachShapes(interactions: RawInteraction[]): WatchStep[] {
  return interactions.map((it): WatchStep => {
    if (it.action === 'click' && it.win && it.pt && it.pt.x >= 0 && it.pt.y >= 0 && it.pt.x < it.win.w && it.pt.y < it.win.h) {
      return { kind: 'click', app: it.app ?? '', win: it.win, x: it.pt.x, y: it.pt.y, at: it.ts, ...(it.mods ? { mods: it.mods } : {}) };
    }
    if (it.action === 'press_keys' && it.win && watchKeysOk(it.value ?? '')) {
      return { kind: 'keys', app: it.app ?? '', win: it.win, keys: it.value!, at: it.ts };
    }
    // Typing, or a step with no place: there is a part here that a round cannot carry.
    return { kind: it.action === 'set_value' ? 'typed' : 'gap', at: it.ts };
  });
}

/** The most a step that types may hold. A longer one is not kept for doing again by place. */
export const NOTCH_PLACED_TEXT_MAX = 2000;

/**
 * What was shown, as steps that can be done again by place: each click with
 * the place in its window where it was made, each named key, each field's
 * words. Null when one of the steps has no place to be done at (an app that
 * was opened, a click the desktop app told with no window), or types more
 * than is kept: then the job cannot be done again this way at all, and
 * doing half of it would be worse.
 */
export function teachPlaced(interactions: RawInteraction[]): PlacedStep[] | null {
  const steps: PlacedStep[] = [];
  for (const it of interactions) {
    if (!it.win) return null;
    const app = it.app ?? '';
    if (it.action === 'click') {
      if (!it.pt || it.pt.x < 0 || it.pt.y < 0 || it.pt.x >= it.win.w || it.pt.y >= it.win.h) return null;
      steps.push({ kind: 'click', app, win: it.win, x: it.pt.x, y: it.pt.y, ...(it.mods ? { mods: it.mods } : {}) });
    } else if (it.action === 'press_keys') {
      if (!watchKeysOk(it.value ?? '')) return null;
      steps.push({ kind: 'keys', app, win: it.win, keys: it.value! });
    } else if (it.action === 'set_value') {
      // What was typed into a password field was never kept, and is not typed again.
      if (it.secure || it.value === undefined || it.value === '{{REDACTED}}') { steps.push({ kind: 'secret' }); continue; }
      if (it.value.length > NOTCH_PLACED_TEXT_MAX) return null;
      // A field left empty is a step that typed nothing.
      if (it.value !== '') steps.push({ kind: 'type', app, win: it.win, text: it.value });
    } else {
      return null;
    }
  }
  return steps.length > 0 ? steps : null;
}

/** Rounds moved on by `n`: after Jarvis did that many, the next one starts further along. */
export function advanceRounds(rounds: Rounds, n: number, at: number): Rounds {
  return {
    ...rounds, at,
    steps: rounds.steps.map((step) => (step.kind === 'click' ? { ...step, x: step.x + n * step.dx, y: step.y + n * step.dy } : step)),
  };
}

/** A job that was shown, as it is kept. */
export interface NotchLearned {
  id: string;
  createdAt: number;
  /** The name of the skill that holds its steps. */
  skill: string;
  /** What it does, in a few words. */
  what: string;
  steps: number;
  /** "Monday at 9:00", or null when it is done on request only. */
  schedule: string | null;
  nextAt: number | null;
  /** Its steps as they are done again by place, when every one of them has a place. */
  placed: PlacedStep[] | null;
}

interface StoredLearned { id: string; created_at: number; skill: string; what: string; steps: number; schedule: string | null; next_at: number | null; placed: string | null }

function placedOf(stored: string | null): PlacedStep[] | null {
  if (!stored) return null;
  try {
    const raw: unknown = JSON.parse(stored);
    if (!Array.isArray(raw) || raw.length === 0) return null;
    const kinds = new Set(['click', 'keys', 'type', 'secret']);
    return raw.every((step) => typeof step === 'object' && step !== null && kinds.has((step as { kind?: unknown }).kind as string)) ? (raw as PlacedStep[]) : null;
  } catch { return null; }
}

export class NotchLearnedStore {
  constructor(private readonly db: Database, private readonly now: () => number = Date.now) {
    db.run(`CREATE TABLE IF NOT EXISTS notch_learned (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      skill TEXT NOT NULL,
      what TEXT NOT NULL,
      steps INTEGER NOT NULL,
      schedule TEXT,
      next_at INTEGER,
      placed TEXT
    )`);
    // A table made before jobs could be done again by place has no such column.
    const columns = db.query<{ name: string }, []>('PRAGMA table_info(notch_learned)').all();
    if (!columns.some((column) => column.name === 'placed')) db.run('ALTER TABLE notch_learned ADD COLUMN placed TEXT');
  }

  add(skill: string, what: string, steps: number, placed: PlacedStep[] | null = null): NotchLearned {
    const id = crypto.randomUUID();
    this.db.run('INSERT INTO notch_learned (id, created_at, skill, what, steps, placed) VALUES (?, ?, ?, ?, ?, ?)',
      [id, this.now(), skill, what.slice(0, 200), steps, placed ? JSON.stringify(placed) : null]);
    return this.get(id)!;
  }

  get(id: string): NotchLearned | null {
    const row = this.db.query<StoredLearned, [string]>('SELECT * FROM notch_learned WHERE id = ?').get(id);
    return row ? this.parse(row) : null;
  }

  /** Newest first. */
  all(): NotchLearned[] {
    return this.db.query<StoredLearned, []>('SELECT * FROM notch_learned ORDER BY created_at DESC LIMIT 50').all().map((row) => this.parse(row));
  }

  schedule(id: string, schedule: string | null, nextAt: number | null): void {
    this.db.run('UPDATE notch_learned SET schedule = ?, next_at = ? WHERE id = ?', [schedule, nextAt, id]);
  }

  remove(id: string): void {
    this.db.run('DELETE FROM notch_learned WHERE id = ?', [id]);
  }

  /** The ones whose time has come. */
  due(now: number): NotchLearned[] {
    return this.db.query<StoredLearned, [number]>('SELECT * FROM notch_learned WHERE next_at IS NOT NULL AND next_at <= ? ORDER BY next_at').all(now)
      .map((row) => this.parse(row));
  }

  private parse(row: StoredLearned): NotchLearned {
    return {
      id: row.id, createdAt: row.created_at, skill: row.skill, what: row.what, steps: row.steps, schedule: row.schedule, nextAt: row.next_at,
      placed: placedOf(row.placed),
    };
  }
}

/** What saving a showing came to. */
export type NotchSaved =
  | { ok: true; skill: string; steps: number; notes: string[]; apps: string[] }
  | { ok: false; why: string };

/** What a saved job would do beyond clicking, read from its steps. */
export interface NotchSkillEffect { pays: boolean; deletes: boolean; missing: boolean }

export interface NotchTeachDeps {
  inbox: NotchInbox;
  jobs: NotchJobs;
  hands: NotchJobHands;
  db: Database;
  /** The product's recorder, on the person's machine and in the brain. */
  recorder: {
    /** Starts watching. `why` is said to the person when it could not. */
    start(maxMs: number): Promise<{ ok: true } | { ok: false; why: string }>;
    /** Stops watching and gives what was shown. */
    stop(): Promise<RawInteraction[]>;
    /** Hears each step as it is seen. Comes back with how to stop hearing. */
    onStep(listener: (interaction: RawInteraction, count: number) => void): () => void;
  };
  /** Saves what was shown as a skill. */
  save(interactions: RawInteraction[]): NotchSaved;
  /** Says what a job does in a few words, from the notes of its steps. Null when it cannot. */
  describe?(notes: string[]): Promise<string | null>;
  /** Removes a saved job's skill. */
  forget(skill: string): void;
  /** What a saved job would do beyond clicking. */
  effect(skill: string): NotchSkillEffect;
  /**
   * Does a saved job once, as it was shown, from step `from`. `target` is
   * told where a step is about to land, in the screen's own pixels.
   */
  runSkill(skill: string, from: number, options: NotchRunOptions & { target(at: { x: number; y: number }): Promise<void> }):
    Promise<{ end: NotchJobEnd; next: number }>;
  /**
   * Whether a shown job can only be done again by place on the person's
   * machine. True where the product cannot find a thing again by what it is
   * called (a Mac, today). Elsewhere a job is done by place when its window
   * is there as it was, and by name when it is not.
   */
  byPlace?(): boolean;
  /** How many more there are of a round (catch.ts). */
  count?(request: Record<string, unknown>): Promise<number | null>;
  /** The jobs caught by themselves: "do the rest" may mean one of those. */
  catcher?: () => NotchCatch | null;
  paused?: () => boolean;
  now?: () => number;
  log?: (line: string) => void;
}

export interface NotchTeach {
  /** Whether Jarvis is being shown a job now. */
  watching(): boolean;
  /**
   * What the notch does itself with these words, if they are for it: "Watch
   * me", "done" while it watches, "run it on nine rows", "undo that". Null
   * when they are an instruction like any other.
   */
  route(text: string): { did: string; run(): void } | null;
  /** Its words, as intents of the one table (./intents.ts). `route` is the first of them that takes a sentence. */
  intents(): readonly NotchIntent[];
  /**
   * Whether these words begin as the words for a job, and there is a job they could mean: "continue with the
   * draft to Sam". They are then the job (when nothing else is in them) or an instruction, and never a
   * sentence that is read for whom it names.
   */
  begins(text: string): boolean;
  /** Home's row about the jobs it was shown, when there are any, and the sheet it opens. */
  row(): NotchBlock | null;
  open(stage: NotchStage): Promise<void>;
  /** Looks at the clock: a job whose time has come is offered. */
  tick(): void;
  stop(): void;
}

export function attachNotchTeach(deps: NotchTeachDeps): NotchTeach {
  const log = deps.log ?? ((line: string) => console.log(line));
  const now = deps.now ?? Date.now;
  const store = new NotchLearnedStore(deps.db, now);
  /** The showing under way. */
  let session: { count: number; last: string; ended: 'done' | 'gone' | null; waiters: Set<() => void>; unhear: () => void; cap: ReturnType<typeof setTimeout> | null } | null = null;
  /** The rounds of the last showing, moved on by what Jarvis did since: where "run it on nine rows" goes on from. */
  let fresh: { rounds: Rounds; learned: string } | null = null;
  let stopped = false;
  let tells = 0;

  const tell = (parts: NotchPart[], mood: 'careful' | 'look' | 'sorry' | 'confused' = 'careful', ms = 4000): void => {
    const id = `teach-tell-${++tells}`;
    deps.inbox.add({
      id, subject: id, class: 'person', speaks: true, urgent: true, once: true, asked: true,
      title: () => parts,
      play: async (stage) => { await stage.say(parts, ms, { mood }); return 'settled'; },
    });
  };

  const wake = (): void => {
    if (!session) return;
    const waiters = [...session.waiters];
    session.waiters.clear();
    for (const waiter of waiters) waiter();
  };

  async function countLeft(rounds: Rounds): Promise<number | null> {
    const request = countRequest(rounds);
    if (!request || !deps.count) return null;
    try {
      const after = await deps.count(request);
      return after === null ? null : roundsToDo(rounds, after);
    } catch { return null; }
  }

  /** Runs rounds from where they stand, and keeps where they have got to for "go on" said later. */
  function startRounds(rounds: Rounds, count: number | null, learnedId: string): boolean {
    const run = newRoundsRun(rounds, count);
    const plan = roundsPlan(run, deps.hands, roundsWords(rounds, roundsApps(rounds)));
    const began = deps.jobs.start({
      ...plan,
      async run(options) {
        const end = await plan.run(options);
        // Where the next one would begin, should the person ask for more.
        if (fresh?.learned === learnedId) fresh = { rounds: advanceRounds(rounds, run.done, now()), learned: learnedId };
        return end;
      },
    });
    if (began) fresh = { rounds, learned: learnedId };
    return began;
  }

  /** A saved job as something the notch can run once, step by step. */
  function skillPlan(learned: NotchLearned): NotchJobPlan {
    let next = 0;
    const steps = (n: number): string => (n === 1 ? '1 step' : `${n} steps`);
    return {
      kind: 'skill', total: learned.steps,
      words: { doing: 'Doing it as you showed me', said: steps, title: (done) => `Did what you showed me: ${learned.what} (${done} of ${steps(learned.steps)})` },
      done: () => next,
      puts: () => [],
      canGoOn: () => next < learned.steps,
      async run(options) {
        const result = await deps.runSkill(learned.skill, next, {
          ...options,
          onProgress: (done) => { next = done; options.onProgress(done); },
          // Jarvis's pointer goes to the place before the step lands there.
          target: async (at) => {
            try {
              const sent = await deps.hands.act({ do: 'hand', screen: true, x: at.x, y: at.y, hand: 0 });
              // It is seen to land before the step does.
              if (sent?.ms && sent.ms > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(900, sent.ms! + 60)));
            } catch { /* the step does not wait for a pointer */ }
          },
        });
        next = result.next;
        return result.end;
      },
    };
  }

  /** A saved job done again by place: each step where it was made, in the window it was made in. */
  function placedPlan(learned: NotchLearned, placed: PlacedStep[]): NotchJobPlan {
    const run = newPlacedRun(placed);
    const steps = (n: number): string => (n === 1 ? '1 step' : `${n} steps`);
    return {
      kind: 'skill', total: placed.length,
      words: { doing: 'Doing it as you showed me', said: steps, title: (done) => `Did what you showed me: ${learned.what} (${done} of ${steps(placed.length)})` },
      done: () => run.next,
      puts: () => [],
      canGoOn: () => run.next < placed.length,
      run: (options) => runPlaced(run, deps.hands, options),
    };
  }

  /** Does a saved job once. A job that pays is refused; one that deletes asks first. */
  /** Whether the window a job was shown in is there now, the same program at the same size. Asking touches nothing. */
  async function windowThere(placed: PlacedStep[]): Promise<boolean> {
    const first = placed.find((step): step is Exclude<PlacedStep, { kind: 'secret' }> => step.kind !== 'secret');
    if (!first) return false;
    try {
      const found = await deps.hands.act({ do: 'find', app: first.app, win: { id: first.win.id, pid: first.win.pid, w: first.win.w, h: first.win.h } });
      return found?.done === true && !!found.win;
    } catch {
      return false;
    }
  }

  /**
   * Whether the window a job was shown in is the one in front now: that very window, by its number and its
   * program's. Another window of the same program is not it, also at the same size (two browser windows, both
   * as large as the screen), and neither is the program started again. Asking touches nothing. No window in
   * front, one of Jarvis's own, or a machine that cannot say: not in front.
   */
  async function windowInFront(placed: PlacedStep[] | null): Promise<boolean> {
    const first = placed?.find((step): step is Exclude<PlacedStep, { kind: 'secret' }> => step.kind !== 'secret');
    if (!first) return false;
    try {
      const front = await deps.hands.act({ do: 'front' });
      if (front?.done !== true || !front.win) return false;
      return front.win.id === first.win.id && front.win.pid === first.win.pid;
    } catch {
      return false;
    }
  }

  /**
   * Does a saved job once. `said`: it was asked for by words alone ("do it again"). Shown in the last three
   * minutes it is done at once, as ever: the person has only just shown it. Later it is done at once only when
   * its window is the one in front, and otherwise it is asked about first:
   * words that could have meant something else never set the hands to work in a window that is not there to
   * be seen (the owner, 26 November 2026). Asked for on its own row, or at its time and answered with a yes,
   * it is done as before.
   */
  function startSkill(learned: NotchLearned, said = false): void {
    const effect = deps.effect(learned.skill);
    if (effect.missing) { tell(['I no longer have that job. Show me again.'], 'sorry'); return; }
    if (effect.pays) { tell(['That job pays for something. I do not do that from here.']); return; }
    // Where nothing can be found again by its name (the Mac), a job is only ever done by place.
    const onlyPlace = deps.byPlace?.() === true;
    if (onlyPlace && !learned.placed) {
      tell(['I cannot do that one again here: one of its steps has no place I can go back to. Show me again, with clicks and keys only.'], 'sorry', 6000);
      return;
    }
    const begin = (): void => {
      void (async () => {
        // Done where it was done, when the window is there as it was: that
        // works in any program, a page in a browser too, where a field has
        // no name to be found by (the owner's first "run it", 16 November
        // 2026, stopped at "I could not find the next thing to click").
        // With the window gone or another size, each thing is looked for by
        // its name instead, where that can be done at all.
        const placed = learned.placed && (onlyPlace || await windowThere(learned.placed)) ? learned.placed : null;
        const plan = placed ? placedPlan(learned, placed) : skillPlan(learned);
        if (!deps.jobs.start(plan)) tell(['I am in the middle of something else.']);
      })();
    };
    if (!effect.deletes) {
      if (!said || now() - learned.createdAt < NOTCH_TEACH_FRESH_MS) { begin(); return; }
      void (async () => {
        if (await windowInFront(learned.placed)) { begin(); return; }
        if (stopped) return;
        const id = `teach-again-${++tells}`;
        const line = (): NotchPart[] => ['Do ', em(short(learned.what, 60)), ' again?'];
        deps.inbox.add({
          id, subject: id, class: 'person', speaks: true, urgent: true, asked: true,
          title: line,
          play: async (stage) => {
            const answer = await stage.offer(line(), 'do it', { mood: 'look', fold: 0 });
            // Asked a moment ago, and things may have changed since: stopped, or busy with something else.
            if (answer.act !== 'yes') return 'settled';
            if (deps.paused?.()) { await stage.say(['Everything is stopped. Wake me first.'], 3200, { mood: 'careful' }); return 'settled'; }
            begin();
            return 'settled';
          },
        });
      })().catch((error) => { log(`[notch] a shown job could not be asked about: ${error instanceof Error ? error.message : String(error)}`); });
      return;
    }
    // A job that deletes is asked about either way, and that question is the line: it is not asked twice.
    const id = `teach-delete-${++tells}`;
    deps.inbox.add({
      id, subject: id, class: 'person', speaks: true, urgent: true, asked: true,
      title: () => ['That job deletes something. Do it?'],
      play: async (stage) => {
        const answer = await stage.offer(['That job ', em('deletes'), ' something. Do it?'], 'do it', { mood: 'careful', fold: 0 });
        if (answer.act === 'yes') begin();
        return 'settled';
      },
    });
  }

  /** What was shown is over: it is saved, and the notch says what it learned and what it can do with it. */
  async function learned(stage: NotchStage, interactions: RawInteraction[]): Promise<void> {
    if (interactions.length === 0) {
      await stage.say(['I saw nothing to learn. Show me any time.'], 2800);
      return;
    }
    let saved: NotchSaved;
    try { saved = deps.save(interactions); } catch (error) {
      log(`[notch] what was shown could not be saved: ${error instanceof Error ? error.message : String(error)}`);
      saved = { ok: false, why: 'I could not save what you showed me. Nothing was kept.' };
    }
    if (!saved.ok) {
      await stage.say([saved.why], 4600, { mood: 'sorry' });
      return;
    }
    let what: string | null = null;
    try { what = (await Promise.race([deps.describe?.(saved.notes) ?? null, stage.wait(6000).then(() => null)])) ?? null; } catch (error) {
      if (error instanceof NotchStageEnded) throw error;
    }
    const where = saved.apps.length ? `in ${saved.apps.slice(0, 2).join(' and ')}` : 'on your screen';
    const row = store.add(saved.skill, what ?? `${saved.steps} steps ${where}`, saved.steps, teachPlaced(interactions));
    log(`[notch] a job was shown and saved: ${saved.steps} step(s)`);
    const shown = findRounds(teachShapes(interactions));
    if (shown && now() - shown.at < NOTCH_TEACH_FRESH_MS) {
      const times = shown.shown === 2 ? 'twice' : `${shown.shown} times`;
      const size = shown.steps.length === 1 ? '1 step' : `${shown.steps.length} steps`;
      // The same thing done twice. Going on needs each step to land exactly: the rows are measured on the screen.
      const rounds = await sureRounds(shown, deps.hands);
      if (!rounds) {
        await stage.say(['Learned it in ', em(size), ', done ', em(times), '. ', NOTCH_ROWS_NOT_SEEN], 6000, { mood: 'careful' });
        return;
      }
      // A job that pays is never taken over, and one that deletes is asked about: the same rule as for a job
      // done again as it was shown (`startSkill`). Rounds had no such check at all: "Pay now" shown twice was
      // offered as "I can take it from here: 6 left", and one yes clicked it six times.
      const effect = deps.effect(saved.skill);
      if (effect.pays) {
        await stage.say(['Learned it in ', em(size), ', done ', em(times), '. It pays for something, so I do not take it over.'], 6000, { mood: 'careful' });
        return;
      }
      // The rest of it is there to do now.
      fresh = { rounds, learned: row.id };
      const left = await countLeft(rounds);
      const per = rounds.steps.length;
      const parts: NotchPart[] = [
        'Learned it in ', em(per === 1 ? '1 step' : `${per} steps`), ', done ', em(rounds.shown === 2 ? 'twice' : `${rounds.shown} times`),
        '. I can take it from here', ...(left && left > 0 ? [': ', em(`${left} left`)] : []), '.',
      ];
      if (left === 0) {
        await stage.say(['Learned it in ', em(per === 1 ? '1 step' : `${per} steps`), ', done ', em(rounds.shown === 2 ? 'twice' : `${rounds.shown} times`), '. Nothing is left to do there.'], 4600, { mood: 'proud', mark: 'check' });
        return;
      }
      const answer = await stage.offer(parts, 'take over', { mood: 'proud', fold: 0 });
      if (answer.act !== 'yes') return;
      if (effect.deletes) {
        const sure = await stage.offer(['That job ', em('deletes'), ' something', ...(left && left > 0 ? [', ', em(`${left} more times`)] : []), '. Do it?'], 'do it', { mood: 'careful', fold: 0 });
        if (sure.act !== 'yes') return;
      }
      if (left === null && !roundsCopy(rounds)) {
        await stage.say(['Tell me how many: "run it on nine".'], 4200);
        return;
      }
      if (!startRounds(rounds, left, row.id)) await stage.say(['I am in the middle of something else.'], 3000, { mood: 'careful' });
      return;
    }
    // A job to do again as it was shown: on request, or at a time of the week.
    let when = NOTCH_SCHEDULES[0]!;
    const say = (): NotchPart[] => [
      'Learned it in ', em(saved.steps === 1 ? '1 step' : `${saved.steps} steps`), ...(what ? [': ', what] : []),
      '. Do it every ', word('when', when, NOTCH_SCHEDULES, { label: 'Schedule', read: 'sched' }), '?',
    ];
    const id = stage.id();
    stage.put({ id, kind: 'offer', say: say(), yes: 'yes', mood: 'proud', fold: 0 });
    for (;;) {
      const answer = await stage.answer(id, ['yes', 'no', 'fold', 'word']);
      if (answer.act === 'word') {
        if (answer.word === 'when' && parseSchedule(answer.value ?? '')) when = answer.value!;
        // Said again as it stands: a value that is not a time of the week does not stay on the line.
        stage.surface.update(id, { say: say() });
        continue;
      }
      if (answer.act !== 'yes') {
        await stage.say(['Kept. Say "run it" when you want it done.'], 3200);
        return;
      }
      const schedule = parseSchedule(when);
      if (schedule) store.schedule(row.id, when, nextScheduled(schedule, now()));
      await stage.say(['Every ', em(when), ', I will ask you here and do it on your yes.'], 5200, { mood: 'happy', mark: 'check' });
      return;
    }
  }

  function watch(): void {
    if (session) { tell(['I am watching already. Press done when you have shown me.']); return; }
    if (deps.paused?.()) { tell(['Everything is stopped. Wake me first.']); return; }
    if (deps.jobs.busy()) { tell(['I am in the middle of something. Stop it first.']); return; }
    const mine = { count: 0, last: '', ended: null as 'done' | 'gone' | null, waiters: new Set<() => void>(), unhear: () => {}, cap: null as ReturnType<typeof setTimeout> | null };
    session = mine;
    deps.catcher?.()?.reset();
    let started: Promise<{ ok: true } | { ok: false; why: string }> | null = deps.recorder.start(NOTCH_TEACH_MAX_MS);
    mine.unhear = deps.recorder.onStep((interaction, count) => {
      if (session !== mine) return;
      mine.count = count;
      mine.last = teachStepSaid(interaction);
      wake();
    });
    // The desktop app stops by itself at the same time: this is the brain's own end of it.
    mine.cap = setTimeout(() => { if (session === mine && !mine.ended) { mine.ended = 'gone'; wake(); } }, NOTCH_TEACH_MAX_MS);
    (mine.cap as { unref?: () => void }).unref?.();
    const over = (): void => {
      mine.unhear();
      if (mine.cap) clearTimeout(mine.cap);
      if (session === mine) session = null;
    };
    deps.inbox.add({
      id: 'teach', subject: 'teach', class: 'person', speaks: true, urgent: true, asked: true, returns: true,
      title: () => ['Watching what you show me'],
      play: async (stage) => {
        if (started) {
          const began = await started;
          started = null;
          if (!began.ok) {
            over();
            await stage.say([began.why], 4600, { mood: 'sorry' });
            return 'settled';
          }
        }
        const line = (): NotchPart[] => (mine.count === 0
          ? ['Watching. Do it once by hand, then press done.']
          : ['Watching. ', em(`Step ${mine.count}`), ': ', mine.last, '.']);
        const id = stage.id();
        stage.put({ id, kind: 'offer', say: line(), yes: 'done', mood: 'curious', fold: 0 });
        const answered = stage.answer(id, ['yes', 'no']);
        answered.catch(() => {});
        let shown = mine.count;
        for (;;) {
          // "Done" may have been said while the talking had the notch: the showing is over when this line is
          // back, and waits for nothing more. (It waited for a key or a step, and the person's next click
          // became a step of the job.)
          const what = mine.ended ? ('changed' as const) : await Promise.race([
            answered.then((answer) => answer.act),
            new Promise<'changed'>((resolve) => { mine.waiters.add(() => resolve('changed')); }),
          ]);
          if (what === 'no') {
            // Esc: thrown away. Nothing of it is kept.
            over();
            await deps.recorder.stop().catch(() => []);
            return 'settled';
          }
          if (what === 'yes' || mine.ended) {
            const ran = mine.ended === 'gone';
            over();
            const interactions = await deps.recorder.stop().catch((): RawInteraction[] => []);
            if (ran && interactions.length > 0) await stage.say(['I stopped watching after ten minutes. I keep what I saw.'], 3600, { mood: 'careful' });
            await learned(stage, interactions);
            return 'settled';
          }
          if (mine.count !== shown) {
            shown = mine.count;
            stage.surface.update(id, { say: line() });
            // A nod for each step it saw.
            stage.surface.act({ gesture: 'nodg' });
          }
        }
      },
    });
  }

  /** "Run it", with or without a number. */
  async function runIt(count: number | null): Promise<void> {
    if (deps.paused?.()) { tell(['Everything is stopped. Wake me first.']); return; }
    if (deps.jobs.busy()) { tell(['I am in the middle of something. Stop it first.']); return; }
    // The rounds of the last showing, while they are still where to go on from.
    if (fresh && now() - fresh.rounds.at < NOTCH_TEACH_FRESH_MS) {
      let n = count;
      if (n === null) {
        n = await countLeft(fresh.rounds);
        if (n === 0) { tell(['Nothing is left to do there.'], 'look'); return; }
        if (n === null && !roundsCopy(fresh.rounds)) { tell(['Tell me how many: "run it on nine".']); return; }
      }
      const rounds = fresh.rounds, learnedId = fresh.learned;
      const begin = (): void => { if (!startRounds(rounds, n, learnedId)) tell(['I am in the middle of something else.']); };
      const skill = store.get(learnedId)?.skill;
      const effect = skill ? deps.effect(skill) : null;
      if (effect?.pays) { tell(['That job pays for something. I do not do that from here.']); return; }
      if (!effect?.deletes) { begin(); return; }
      const id = `teach-delete-${++tells}`;
      deps.inbox.add({
        id, subject: id, class: 'person', speaks: true, urgent: true, asked: true,
        title: () => ['That job deletes something. Do it?'],
        play: async (stage) => {
          const answer = await stage.offer(['That job ', em('deletes'), ' something. Do it?'], 'do it', { mood: 'careful', fold: 0 });
          if (answer.act === 'yes') begin();
          return 'settled';
        },
      });
      return;
    }
    // A job begun by hand and not shown: the catcher has it.
    const took = await deps.catcher?.()?.take(count);
    if (took === 'started') return;
    if (took === 'nothing') { tell(['Nothing is left to do there.'], 'look'); return; }
    if (took === 'how-many') { tell(['Tell me how many: "do the next nine".']); return; }
    if (took === 'unseen') { tell([NOTCH_ROWS_NOT_SEEN], 'sorry', 4600); return; }
    if (took === 'busy') { tell(['I am in the middle of something else.']); return; }
    if (fresh) {
      // It was the same thing done twice, and too long ago: the windows may have moved on since.
      fresh = null;
      tell(['Do one by hand first, then say it again. I go on from where you are.'], 'careful', 5200);
      return;
    }
    const [last] = store.all();
    if (!last) { tell(['I have not been shown a job yet. Say "watch me" and do it once.'], 'confused', 4600); return; }
    // By words alone: at once when it was only just shown or its window is in front, and asked about otherwise.
    startSkill(last, true);
  }

  /** The jobs it was shown, as a sheet: each can be run, taken off its schedule, or forgotten. */
  async function open(stage: NotchStage): Promise<void> {
    for (;;) {
      const all = store.all();
      const blocks: NotchBlock[] = all.length === 0
        ? [{ kind: 'note', say: ['Nothing yet. Say "watch me", do a job once, and press done.'] }]
        : all.map((row): NotchBlock => ({
          kind: 'row', id: row.id, say: [short(row.what, 90)], small: row.schedule ? `every ${row.schedule}` : 'on request',
          buttons: [
            { id: 'run', label: 'Run' },
            ...(row.schedule ? [{ id: 'unschedule', label: 'Stop asking', quiet: true }] : []),
            { id: 'forget', label: 'Forget', quiet: true },
          ],
        }));
      const answer = await stage.sheet([all.length === 1 ? 'Jobs you showed me: 1' : `Jobs you showed me: ${all.length}`], blocks);
      if (answer.act !== 'button' || !answer.row) return;
      const row = store.get(answer.row);
      if (!row) continue;
      if (answer.button === 'run') { startSkill(row); return; }
      if (answer.button === 'unschedule') { store.schedule(row.id, null, null); continue; }
      if (answer.button === 'forget') {
        // A delete asks.
        const sure = await stage.offer(['Forget ', em(short(row.what, 60)), '?'], 'forget', { mood: 'careful', fold: 0 });
        if (sure.act === 'yes') {
          try { deps.forget(row.skill); } catch (error) { log(`[notch] a shown job's skill could not be removed: ${error instanceof Error ? error.message : String(error)}`); }
          store.remove(row.id);
          if (fresh?.learned === row.id) fresh = null;
        }
      }
    }
  }

  const intents: NotchIntent[] = [{
    // It ends the showing, and what was shown is then kept as a job.
    id: 'teach.done', feature: 'teach', says: 'the showing is over', band: 'up', act: 'create', first: 'acts',
    live: 'the showing that is under way, with its line up',
    examples: ['done', "that's it"],
    match(text) {
      if (stopped || !session || !teachDoneWord(text)) return null;
      const mine = session;
      return { did: 'Ended the showing.', run: () => { if (session === mine && !mine.ended) { mine.ended = 'done'; wake(); } } };
    },
  }, {
    // What is shown is kept only on "done", said or pressed on the line that is up all the while: Esc throws it away.
    id: 'teach.watch', feature: 'teach', says: 'watch a job being shown, to learn it', band: 'command', act: 'create', first: 'yes',
    examples: ['watch me', 'let me show you'],
    over: ['said.answer'],
    match(text) {
      if (stopped) return null;
      return watchMeRequest(text) ? { did: 'Began watching what you show me.', run: watch } : null;
    },
  }, {
    id: 'teach.undo', feature: 'teach', says: 'take back the last thing the notch pasted', band: 'command', act: 'screen', first: 'acts',
    live: 'the last paste the notch made itself: with none, nothing is touched',
    examples: ['undo', 'undo that', 'take it back'],
    // Taking back is still the notch's own when the words answer a question the assistant asked.
    inReply: true,
    over: ['said.answer'],
    match(text) {
      if (stopped || !undoRequest(text)) return null;
      return { did: 'Took back my last paste.', run: () => { if (!deps.jobs.undoLast()) tell(['Nothing of mine to undo.'], 'look', 2800); } };
    },
  }, {
    id: 'teach.run', feature: 'teach', says: 'do the job that was shown again, or go on with it', band: 'command', act: 'screen', first: 'acts',
    live: 'a job shown or begun by hand in the last three minutes, or the very window of the last shown job in front: with neither, it asks first',
    examples: ['run it on nine rows', 'do it again', 'do the rest'],
    never: ['do it by email', 'do that tomorrow morning instead', 'continue with the draft to Sam', 'finish it by Friday', 'run the same report as last week',
      'repeat that please, I did not hear', 'do this for all the files in downloads', 'do them one at a time please', 'carry on with the summary',
      'do the same for the other file', 'do it on the other file', 'do the other thing', 'do it for me', 'do it with me', 'continue with the rest', 'do it at 5'],
    over: ['said.answer'],
    match(text) {
      if (stopped) return null;
      const run = runItRequest(text);
      // Only when there is something it could mean: otherwise the words are an instruction like any other.
      if (run && (fresh || store.all().length > 0 || deps.catcher?.()?.last())) {
        return { did: 'Did the job again.', run: () => { void runIt(run.count); } };
      }
      return null;
    },
  }];
  return {
    watching: () => session !== null,
    route: (text) => routeByIntents(intents, text),
    intents: () => intents,
    begins: (text) => !stopped && runItBegins(text) && (fresh !== null || store.all().length > 0 || !!deps.catcher?.()?.last()),
    row() {
      const n = store.all().length;
      return n === 0 ? null : { kind: 'row', id: 'learned', say: [em(n === 1 ? '1 job' : `${n} jobs`), ' you showed me.'], go: true };
    },
    open,
    tick() {
      if (stopped || deps.paused?.()) return;
      const at = now();
      for (const row of store.due(at)) {
        const schedule = row.schedule ? parseSchedule(row.schedule) : null;
        if (!schedule || row.nextAt === null) { store.schedule(row.id, null, null); continue; }
        const due = row.nextAt;
        store.schedule(row.id, row.schedule, nextScheduled(schedule, at));
        // Its time passed while nobody could be asked: it is not done late.
        if (at - due > NOTCH_SCHEDULE_LATE_MS) continue;
        const id = `sched:${row.id}`;
        deps.inbox.add({
          id, subject: id, class: 'clock', speaks: true,
          title: () => ['Shall I do ', em(short(row.what, 60)), ' now?'],
          check: () => store.get(row.id)?.schedule === row.schedule && now() - due < 4 * 3_600_000,
          play: async (stage) => {
            const answer = await stage.offer(['It is ', em(row.schedule!.replace(/^day at /, '')), '. Shall I do it now: ', short(row.what, 70), '?'], 'do it', { mood: 'look' });
            if (answer.act === 'yes') startSkill(row);
            return answer.act === 'fold' ? 'waits' : 'settled';
          },
        });
      }
    },
    stop() {
      stopped = true;
      if (session) { session.unhear(); if (session.cap) clearTimeout(session.cap); session = null; void deps.recorder.stop().catch(() => {}); }
    },
  };
}

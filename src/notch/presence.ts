/**
 * Whether the person is there.
 *
 * The desktop app says when their hands have been off the keyboard and the
 * mouse for four seconds, and when they are back (./where.ts). From those two
 * words alone the notch knows four things, and the rest of pass 8 is built on
 * them:
 *
 *   calm      their hands are still: a line may come up now
 *   left      their hands have been still for twenty minutes: they are away
 *   back      their hands are on again after being away, and for how long
 *   morning   it is the first time they are there today
 *
 * Nothing is read from the screen for this, and the screen being locked is
 * not known: someone who reads for twenty minutes without touching anything
 * is "away" and then "back". That errs towards telling them what changed.
 *
 * A day begins at five in the morning: someone working at one at night is
 * still in yesterday.
 */
import type { NotchSettings } from './settings.ts';
import type { NotchFeatureDef } from './feature.ts';

/** How long hands have to be still for the person to count as away. */
export const NOTCH_AWAY_MS = 20 * 60 * 1000;
/** The hour a day begins at, on this machine's clock. */
export const NOTCH_DAY_STARTS_HOUR = 5;
/** How long they must have been away for the first return of a day to be the morning. */
export const NOTCH_MORNING_AWAY_MS = 60 * 60 * 1000;

/** The day a moment belongs to, as "2026-11-16": the day that began at five that morning. */
export function notchDayOf(at: number): string {
  const day = new Date(at - NOTCH_DAY_STARTS_HOUR * 60 * 60 * 1000);
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
}

export interface NotchPresenceDeps {
  settings: NotchSettings;
  /** Their hands are still: something that waited for that may speak. */
  calm?(): void;
  /** They have been still for twenty minutes: `at` is when their hands went still. */
  left?(at: number): void;
  /** They are back after being away. Not told when it is the morning: that has its own line. */
  back?(away: { since: number; ms: number }): void;
  /** The first time they are there today. */
  morning?(away: { since: number | null; ms: number }): void;
  /** Their hands are on again, after any time still. Told every time, before `back` and `morning`. */
  hands?(): void;
  now?: () => number;
  /** The clock for the wait before "left". Tests give one they can wind forward. */
  clock?: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void };
  log?: (line: string) => void;
}

const MORNING = 'presence.morning';

export class NotchPresence {
  /** Null until the desktop app has said anything: then nothing is known, and nothing is held back for it. */
  private isStill: boolean | null = null;
  private stillSince: number | null = null;
  private away = false;
  /** Whether their hands have been on since the brain started. Until then nothing is known of when they were last there. */
  private everThere = false;
  /** The day whose morning was told to whoever says the morning line. Kept here only: the settings hold the day it was said. */
  private morningTold = '';
  private timer: unknown = null;
  private readonly now: () => number;
  private readonly clock: NonNullable<NotchPresenceDeps['clock']>;

  constructor(private readonly deps: NotchPresenceDeps) {
    this.now = deps.now ?? Date.now;
    this.clock = deps.clock ?? { setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref?.(); return timer; }, clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) };
  }

  /** Whether a line may come up as far as their hands go. True when nothing was ever told. */
  still(): boolean {
    return this.isStill !== false;
  }

  /** Whether they are away now: still for twenty minutes or more. */
  isAway(): boolean {
    return this.away;
  }

  /** How long their hands have been still, in milliseconds. 0 while they move, and while nothing is known. */
  stillFor(): number {
    return this.isStill === true && this.stillSince !== null ? Math.max(0, this.now() - this.stillSince) : 0;
  }

  /** The desktop app's word about their hands (./where.ts). */
  hands(still: boolean): void {
    const at = this.now();
    if (still) {
      if (this.isStill === true) return;
      this.isStill = true;
      this.stillSince = at;
      if (this.timer) this.clock.clearTimeout(this.timer);
      this.timer = this.clock.setTimeout(() => {
        this.timer = null;
        if (this.isStill !== true || this.stillSince !== at) return;
        this.away = true;
        this.tell(() => this.deps.left?.(at));
      }, NOTCH_AWAY_MS);
      this.tell(() => this.deps.calm?.());
      return;
    }
    const since = this.stillSince;
    // The first time their hands are on since the brain started: it may have started while they were out.
    const first = !this.everThere;
    this.everThere = true;
    const wasAway = this.away;
    this.isStill = false;
    this.stillSince = null;
    this.away = false;
    if (this.timer) { this.clock.clearTimeout(this.timer); this.timer = null; }
    this.tell(() => this.deps.hands?.());
    const ms = since === null ? 0 : at - since;
    // The first time today, after a night away or with nothing known of before (the brain has just started).
    const today = notchDayOf(at);
    if (this.deps.settings.get<string>(MORNING, '') !== today && this.morningTold !== today && (first || ms >= NOTCH_MORNING_AWAY_MS)) {
      // Told once a day, and written down when the line has been said
      // (`morningSaid`), not here. Written here, a brain that restarted
      // while the line still waited for a still moment said no morning
      // line that day.
      this.morningTold = today;
      this.tell(() => this.deps.morning?.({ since, ms }));
      return;
    }
    if (wasAway && since !== null) this.tell(() => this.deps.back?.({ since, ms }));
  }

  /** The morning line has been said: there is none again today, also after a restart. */
  morningSaid(): void {
    const at = this.now();
    this.deps.settings.set(MORNING, notchDayOf(at), at);
  }

  stop(): void {
    if (this.timer) this.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  private tell(what: () => void): void {
    try {
      what();
    } catch (error) {
      (this.deps.log ?? ((line: string) => console.log(line)))(`[notch] presence: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/**
 * Whether the person is there (pass 8), as a feature of the notch (./feature.ts). Made right after the inbox,
 * which asks it whether a line may come up. Its hands being back reach the asks, and leaving, coming back and
 * the first time today reach the lines of the day; both are made after it and asked for when it happens.
 * Absent on a brain that was not given where to keep the settings.
 */
export const notchPresenceFeature: NotchFeatureDef<'presence'> = {
  id: 'presence',
  wants: ['asks', 'day'],
  make(ctx) {
    const settings = ctx.settings;
    if (!settings) return null;
    const api = new NotchPresence({
      settings,
      calm: () => ctx.inbox.calmed(),
      hands: () => ctx.use('asks')?.handsOn(),
      left: (at) => ctx.use('day')?.left(at),
      back: (away) => { void ctx.use('day')?.back(away); },
      morning: (away) => ctx.use('day')?.morning(away),
      now: ctx.now,
      clock: ctx.clock,
      log: ctx.log,
    });
    return { api, stop: () => api.stop() };
  },
};

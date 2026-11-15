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
    const first = this.isStill === null;
    const wasAway = this.away;
    this.isStill = false;
    this.stillSince = null;
    this.away = false;
    if (this.timer) { this.clock.clearTimeout(this.timer); this.timer = null; }
    const ms = since === null ? 0 : at - since;
    // The first time today, after a night away or with nothing known of before (the brain has just started).
    const today = notchDayOf(at);
    if (this.deps.settings.get<string>(MORNING, '') !== today && (first || ms >= NOTCH_MORNING_AWAY_MS)) {
      this.deps.settings.set(MORNING, today, at);
      this.tell(() => this.deps.morning?.({ since, ms }));
      return;
    }
    if (wasAway && since !== null) this.tell(() => this.deps.back?.({ since, ms }));
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

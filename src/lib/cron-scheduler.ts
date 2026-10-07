/**
 * CronScheduler — lightweight cron expression parser and scheduler
 *
 * Standard cron (5-field, minute resolution):
 *   "minute hour dayOfMonth month dayOfWeek" with `*`, `/`, `-`, and CSVs
 *
 * Sub-minute extension:
 *   "@every <duration>" where <duration> is `<n>(s|m|h)` -- e.g. `@every 10s`,
 *   `@every 30s`, `@every 5m`. Bounds: minimum 1s, maximum 24h. Implemented
 *   with `setInterval(durationMs)` rather than the per-minute matcher loop,
 *   so triggers like `jarvis-trigger:on_event` can poll faster than once a
 *   minute.
 *
 * No external dependencies.
 */

// ── Types ──

/**
 * One occurrence a job fires for. `key` names the wall-clock minute the
 * expression matched, in the cron timezone ("2026-03-08T02:30"): it is the same
 * after a restart and for both passes through the autumn hour that happens
 * twice, so callers can use it as the occurrence's identity.
 */
export type CronOccurrence = {
  /** Start of the occurrence's minute (epoch ms); after a spring-forward jump, the first minute after it. */
  at: number;
  key: string;
  /** How long after `at` the tick ran. */
  lateMs: number;
  /** The named minute did not exist because clocks jumped forward; it fires once, right after the jump. */
  shifted?: true;
};

export type CronScheduleOptions = {
  /**
   * Occurrences whose minute passed more than `CRON_GRACE_MS` before a tick
   * saw them (the host slept, the process stalled). They are reported, never
   * run late.
   */
  onMissed?: (missed: CronOccurrence[]) => void;
};

/** A tick this late after its minute still fires; later than this, the occurrence was missed. */
export const CRON_GRACE_MS = 2 * 60_000;

export type CronJob = {
  id: string;
  expression: string;
  callback: (occurrence: CronOccurrence) => void;
  lastRun: number | null;
  nextRun: number;
  handle: ReturnType<typeof setInterval>;
  /** Evaluate the job as of `nowMs`. The interval calls it; tests drive time with `runDue`. */
  tick?: (nowMs: number) => void;
};

export type CronJobInfo = {
  id: string;
  expression: string;
  lastRun: number | null;
  nextRun: number;
};

/**
 * Parse the sub-minute `@every <n>(s|m|h)` syntax. Returns the interval in
 * milliseconds, or `null` if the expression isn't using this syntax.
 * Throws if the syntax is recognised but malformed or out of bounds.
 */
const EVERY_RE = /^@every\s+(\d+)(s|m|h)$/i;
const MIN_INTERVAL_MS = 1_000;
const MAX_INTERVAL_MS = 24 * 60 * 60_000;

export function parseEveryExpression(expression: string): number | null {
  const m = EVERY_RE.exec(expression.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2]!.toLowerCase();
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Invalid @every duration in "${expression}": amount must be a positive integer`);
  }
  const ms =
    unit === "s" ? n * 1_000 : unit === "m" ? n * 60_000 : n * 60 * 60_000;
  if (ms < MIN_INTERVAL_MS) {
    throw new Error(
      `@every duration "${expression}" is below the 1s minimum (got ${ms}ms)`,
    );
  }
  if (ms > MAX_INTERVAL_MS) {
    throw new Error(
      `@every duration "${expression}" exceeds the 24h maximum (got ${ms}ms)`,
    );
  }
  return ms;
}

// ── Parser helpers ──

/**
 * Parse a single cron field value into a sorted array of matching integers.
 */
function parseField(field: string, min: number, max: number): number[] {
  const values = new Set<number>();
  for (const part of field.split(',')) {
    const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!match) throw new Error(`Invalid cron field: "${part}"`);
    const range = match[1]!;
    const step = match[2] === undefined ? 1 : Number(match[2]);
    const [a, b] = range.split('-').map(Number);
    const start = range === '*' ? min : a!;
    const end = range === '*' ? max : b ?? (match[2] === undefined ? start : max);
    if (!Number.isSafeInteger(step) || step <= 0 || start < min || end > max || start > end) {
      throw new Error(`Invalid cron field: "${part}" (expected ${min}-${max}, ascending ranges and positive steps)`);
    }
    for (let i = start; i <= end; i += step) values.add(i);
  }

  return Array.from(values).sort((a, b) => a - b);
}

/** The same parser used by scheduling, without registering a timer. */
export function validateCronExpression(expression: string): void {
  if (parseEveryExpression(expression) === null) parseExpression(expression);
}

/**
 * Parse a full 5-field cron expression into its component arrays.
 */
function parseExpression(expression: string): {
  minutes: number[];
  hours: number[];
  daysOfMonth: number[];
  months: number[];
  daysOfWeek: number[];
} {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression "${expression}": expected 5 fields, got ${parts.length}`);
  }

  const [minField, hourField, domField, monthField, dowField] = parts;

  const parsed = {
    minutes: parseField(minField!, 0, 59),
    hours: parseField(hourField!, 0, 23),
    daysOfMonth: parseField(domField!, 1, 31),
    months: parseField(monthField!, 1, 12),
    // Expand ranges/steps before folding the Sunday alias, so 1-7 and
    // 1-7/2 retain their ordinary cron meaning.
    daysOfWeek: [...new Set(parseField(dowField!, 0, 7).map(day => day % 7))].sort((a, b) => a - b),
  };
  // Include leap-day schedules, but refuse impossible dates such as February
  // 31. The runtime matches DOM and month together, just like this check.
  const maxDays = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (!parsed.months.some(month => parsed.daysOfMonth.some(day => day <= maxDays[month - 1]!))) {
    throw new Error('Invalid cron expression: selected days do not exist in the selected months');
  }
  return parsed;
}

// ── Timezone support ──
//
// Cron expressions describe WALL-CLOCK times ("0 7 * * *" = 7am where the
// user lives). By default that is the machine's local time (self-host). A
// hosted brain runs on a UTC VPS, so the daemon sets the user's IANA
// timezone here once at boot (from the system config `timezone` key, which
// the hosting server writes from the sidecar-reported value) and every cron
// in the process - system morning/evening/hourly, workflow triggers, goal
// windows - evaluates in that timezone.

let cronTimezone: string | null = null;

/** Set (or clear) the process-wide cron timezone. Throws on unknown zones. */
export function setCronTimezone(tz: string | null): void {
  if (tz) {
    // Throws RangeError for unknown zone names.
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  }
  cronTimezone = tz;
  wallClockFormatter = null;
}

export function getCronTimezone(): string | null {
  return cronTimezone;
}

let wallClockFormatter: Intl.DateTimeFormat | null = null;

const DOW_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

interface WallClock {
  minute: number;
  hour: number;
  dom: number;
  month: number;
  dow: number;
  year: number;
}

/** Wall-clock components of a timestamp in the configured cron timezone. */
function wallClock(date: Date): WallClock {
  if (!cronTimezone) {
    return {
      minute: date.getMinutes(),
      hour: date.getHours(),
      dom: date.getDate(),
      month: date.getMonth() + 1,
      dow: date.getDay(),
      year: date.getFullYear(),
    };
  }
  wallClockFormatter ??= new Intl.DateTimeFormat('en-US', {
    timeZone: cronTimezone,
    hourCycle: 'h23',
    minute: 'numeric',
    hour: 'numeric',
    day: 'numeric',
    month: 'numeric',
    weekday: 'short',
    year: 'numeric',
  });
  const parts: Record<string, string> = {};
  for (const part of wallClockFormatter.formatToParts(date)) {
    parts[part.type] = part.value;
  }
  return {
    minute: Number(parts.minute),
    hour: Number(parts.hour) % 24, // h23 still yields "24" for midnight in some ICU versions
    dom: Number(parts.day),
    month: Number(parts.month),
    dow: DOW_INDEX[parts.weekday!] ?? 0,
    year: Number(parts.year),
  };
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** The wall-clock minute as text ("2026-03-08T02:30"): comparable, and stable across restarts. */
function wallKey(wc: WallClock): string {
  return `${wc.year}-${pad2(wc.month)}-${pad2(wc.dom)}T${pad2(wc.hour)}:${pad2(wc.minute)}`;
}

/** The next wall-clock minute by the calendar, whether or not the zone's clocks show it. */
function addWallMinute(wc: WallClock): WallClock {
  let { minute, hour, dom, month, year, dow } = wc;
  minute++;
  if (minute === 60) { minute = 0; hour++; }
  if (hour === 24) { hour = 0; dom++; dow = (dow + 1) % 7; }
  if (dom > new Date(Date.UTC(year, month, 0)).getUTCDate()) { dom = 1; month++; }
  if (month === 13) { month = 1; year++; }
  return { minute, hour, dom, month, dow, year };
}

type ParsedCron = ReturnType<typeof parseExpression>;

function matchesWall(parsed: ParsedCron, wc: WallClock): boolean {
  return parsed.minutes.includes(wc.minute) && parsed.hours.includes(wc.hour) && parsed.daysOfMonth.includes(wc.dom)
    && parsed.months.includes(wc.month) && parsed.daysOfWeek.includes(wc.dow);
}

/**
 * A minute the expression names that clocks skipped when they jumped forward
 * into the minute starting at `atMs` (2:30 on a spring-forward night), or null.
 */
function skippedOccurrence(parsed: ParsedCron, atMs: number): { at: number; key: string; shifted: true } | null {
  const now = wallKey(wallClock(new Date(atMs)));
  let step = addWallMinute(wallClock(new Date(atMs - 60_000)));
  // No jump, or clocks went back: nothing was skipped.
  if (wallKey(step) >= now) return null;
  for (let i = 0; i < 180 && wallKey(step) < now; i++, step = addWallMinute(step)) {
    if (matchesWall(parsed, step)) return { at: atMs, key: wallKey(step), shifted: true };
  }
  return null;
}

/** Local calendar date as a single comparable number (yyyymmdd). */
function localDateKey(wc: WallClock): number {
  return wc.year * 10_000 + wc.month * 100 + wc.dom;
}

/**
 * First timestamp of the NEXT local calendar date in the cron timezone.
 * Anchored on the calendar date, not on "wall clock reads 00:00", because
 * both can lie under DST:
 *  - spring-forward days are 23h, so a fixed +24h jump overshoots and a
 *    forward-only "snap to hour 0" then skips an entire day (the original
 *    bug: nextRun for a Monday cron landing on the transition returned the
 *    Monday AFTER);
 *  - in zones where DST starts AT midnight (America/Santiago) the next day
 *    has no 00:xx at all - its first instant reads 01:00.
 * Strategy: jump to the vicinity of the next midnight by wall-clock
 * arithmetic (bounded, over/undershoot at most an hour), then walk by
 * minutes until the local date is exactly `current date + 1 day-key`,
 * i.e. the first minute of the next date whatever its wall time is.
 */
function startOfNextLocalDay(ts: number): number {
  const startKey = localDateKey(wallClock(new Date(ts)));

  // Coarse jump: minutes remaining to nominal midnight. Lands within an hour
  // of the real boundary regardless of a 23/24/25-hour day.
  const wc = wallClock(new Date(ts));
  let candidate = ts + (24 * 60 - (wc.hour * 60 + wc.minute)) * 60_000;

  // A 25-hour day can leave us still on the starting date: take another
  // bounded hop until the date changes.
  for (let i = 0; i < 3 && localDateKey(wallClock(new Date(candidate))) <= startKey; i++) {
    const w = wallClock(new Date(candidate));
    candidate += (24 * 60 - (w.hour * 60 + w.minute)) * 60_000;
  }

  // Walk BACK by minutes while the previous minute is still past the start
  // date - this finds the exact first minute of the next date, and never
  // crosses back onto the start date (so a skipped-midnight day converges on
  // its true first instant, e.g. 01:00 in Santiago).
  let guard = 0;
  while (guard++ < 180) {
    const prev = candidate - 60_000;
    if (localDateKey(wallClock(new Date(prev))) <= startKey) break;
    candidate = prev;
  }
  return candidate;
}

// ── CronScheduler ──

export class CronScheduler {
  private jobs: Map<string, CronJob> = new Map();

  /**
   * Check if a cron expression matches a given date.
   */
  static matches(expression: string, date: Date = new Date()): boolean {
    try {
      return matchesWall(parseExpression(expression), wallClock(date));
    } catch {
      return false;
    }
  }

  /**
   * The occurrences after `afterMs` up to and including `untilMs`, one per
   * wall-clock minute: the autumn hour that happens twice yields its minutes
   * once. Bounded by `limit`.
   */
  static occurrencesBetween(expression: string, afterMs: number, untilMs: number, limit = 1_000): Array<{ at: number; key: string }> {
    const out: Array<{ at: number; key: string }> = [];
    const seen = new Set<string>();
    let cursor = new Date(afterMs);
    for (let i = 0; i < limit; i++) {
      const next = CronScheduler.nextRun(expression, cursor);
      if (!next || next.getTime() > untilMs) break;
      const key = wallKey(wallClock(next));
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ at: next.getTime(), key });
      }
      cursor = next;
    }
    return out;
  }

  /** The wall-clock key of the minute containing `atMs`, in the cron timezone. */
  static minuteKey(atMs: number): string {
    return wallKey(wallClock(new Date(atMs)));
  }

  /**
   * Calculate the next execution time for a cron expression.
   * @param expression - 5-field cron expression
   * @param from - start searching from this date (default: now)
   * @returns Date of next execution, or null if none found within 1 year
   */
  static nextRun(expression: string, from: Date = new Date()): Date | null {
    if (cronTimezone) return CronScheduler.nextRunInTimezone(expression, from);
    try {
      const { minutes, hours, daysOfMonth, months, daysOfWeek } = parseExpression(expression);

      // Start from the next minute
      const start = new Date(from);
      start.setSeconds(0, 0);
      start.setMinutes(start.getMinutes() + 1);

      // Search up to 1 year ahead (minute-by-minute is too slow; step by minute smartly)
      const limit = new Date(from);
      limit.setFullYear(limit.getFullYear() + 1);

      const candidate = new Date(start);

      while (candidate < limit) {
        const month = candidate.getMonth() + 1;
        const dom = candidate.getDate();
        const hour = candidate.getHours();
        const minute = candidate.getMinutes();
        const dow = candidate.getDay();

        if (!months.includes(month)) {
          // Advance to next valid month
          candidate.setMonth(candidate.getMonth() + 1);
          candidate.setDate(1);
          candidate.setHours(0, 0, 0, 0);
          continue;
        }

        if (!daysOfMonth.includes(dom) || !daysOfWeek.includes(dow)) {
          // Advance to next day
          candidate.setDate(candidate.getDate() + 1);
          candidate.setHours(0, 0, 0, 0);
          continue;
        }

        if (!hours.includes(hour)) {
          // Find next valid hour
          const nextHour = hours.find(h => h > hour);
          if (nextHour !== undefined) {
            candidate.setHours(nextHour, 0, 0, 0);
          } else {
            candidate.setDate(candidate.getDate() + 1);
            candidate.setHours(0, 0, 0, 0);
          }
          continue;
        }

        if (!minutes.includes(minute)) {
          // Find next valid minute in this hour
          const nextMinute = minutes.find(m => m > minute);
          if (nextMinute !== undefined) {
            candidate.setMinutes(nextMinute, 0, 0);
          } else {
            // Advance to next valid hour
            const nextHour = hours.find(h => h > hour);
            if (nextHour !== undefined) {
              candidate.setHours(nextHour, 0, 0, 0);
            } else {
              candidate.setDate(candidate.getDate() + 1);
              candidate.setHours(0, 0, 0, 0);
            }
          }
          continue;
        }

        // All fields match
        return new Date(candidate);
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * nextRun for the configured cron timezone: walks timestamps and evaluates
   * the WALL CLOCK at each step, so DST transitions are handled by the tz
   * database instead of local Date setters. Coarse jumps (next local day /
   * next hour boundary) keep it fast; hour offsets in :30/:45 zones are safe
   * because jumps are derived from the wall-clock minute.
   */
  private static nextRunInTimezone(expression: string, from: Date): Date | null {
    try {
      const { minutes, hours, daysOfMonth, months, daysOfWeek } = parseExpression(expression);

      // Start from the next whole minute.
      let ts = Math.floor(from.getTime() / 60_000) * 60_000 + 60_000;
      const limit = from.getTime() + 366 * 24 * 60 * 60_000;
      let guard = 0;

      while (ts < limit && ++guard < 600_000) {
        const wc = wallClock(new Date(ts));
        if (!months.includes(wc.month) || !daysOfMonth.includes(wc.dom) || !daysOfWeek.includes(wc.dow)) {
          ts = startOfNextLocalDay(ts);
          continue;
        }
        if (!hours.includes(wc.hour)) {
          ts += (60 - wc.minute) * 60_000; // next local hour boundary
          continue;
        }
        if (!minutes.includes(wc.minute)) {
          const nextMinute = minutes.find((m) => m > wc.minute);
          ts += nextMinute !== undefined ? (nextMinute - wc.minute) * 60_000 : (60 - wc.minute) * 60_000;
          continue;
        }
        return new Date(ts);
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Schedule a recurring callback based on a cron expression.
   * Uses setInterval to check every 30 seconds which occurrences have come due.
   *
   * Each occurrence fires once: a tick up to `CRON_GRACE_MS` late still fires
   * it (with its lateness); older ones are reported to `onMissed` and never
   * run late. The autumn hour that happens twice fires its minutes once, a
   * minute skipped by a spring-forward jump fires once right after the jump,
   * and a clock stepped back does not fire a minute again.
   */
  schedule(id: string, expression: string, callback: (occurrence: CronOccurrence) => void, options: CronScheduleOptions = {}): void {
    if (this.jobs.has(id)) {
      this.cancel(id);
    }
    const run = (occurrence: CronOccurrence): void => {
      const job = this.jobs.get(id);
      if (job) job.lastRun = Date.now();
      try {
        callback(occurrence);
      } catch (err) {
        console.error(`[CronScheduler] Job "${id}" threw an error:`, err);
      }
    };

    // Sub-minute path: `@every <n>(s|m|h)`. Use setInterval directly so the
    // trigger fires at the requested cadence instead of being clamped to the
    // 1-minute granularity of the standard cron loop.
    const everyMs = parseEveryExpression(expression);
    if (everyMs !== null) {
      const fireAt = Date.now() + everyMs;
      const handle = setInterval(() => {
        const now = Date.now();
        const job = this.jobs.get(id);
        if (job) job.nextRun = now + everyMs;
        const slot = Math.floor(now / everyMs);
        run({ at: slot * everyMs, key: `every:${everyMs}:${slot}`, lateMs: now - slot * everyMs });
      }, everyMs);
      this.jobs.set(id, {
        id,
        expression,
        callback,
        lastRun: null,
        nextRun: fireAt,
        handle,
      });
      console.log(
        `[CronScheduler] Scheduled job "${id}" (${expression}, ${everyMs}ms interval), first run at: ${new Date(fireAt).toISOString()}`,
      );
      return;
    }

    // Standard 5-field cron path.
    const parsed = parseExpression(expression);

    const nextRun = CronScheduler.nextRun(expression);
    if (!nextRun) {
      throw new Error(`Cron expression "${expression}" has no upcoming execution times`);
    }

    // Epoch minutes evaluated so far. The registration minute itself is due,
    // so a job registered at 09:00:40 still fires its 09:00 occurrence.
    let evaluatedThrough = Math.floor(Date.now() / 60_000) - 1;
    // Wall-clock keys already fired, so the repeated autumn hour fires once.
    const fired = new Set<string>();
    const firedOrder: string[] = [];
    const remember = (key: string): void => {
      fired.add(key);
      firedOrder.push(key);
      if (firedOrder.length > 256) fired.delete(firedOrder.shift()!);
    };

    const tick = (nowMs: number): void => {
      const current = Math.floor(nowMs / 60_000);
      // Same minute again, or the clock stepped back: nothing new is due.
      if (current <= evaluatedThrough) return;
      const from = evaluatedThrough;
      evaluatedThrough = current;
      const missed: CronOccurrence[] = [];
      const due: CronOccurrence[] = [];
      for (const occurrence of CronScheduler.occurrencesBetween(expression, from * 60_000, current * 60_000)) {
        if (fired.has(occurrence.key)) continue;
        const lateMs = nowMs - occurrence.at;
        (lateMs > CRON_GRACE_MS ? missed : due).push({ ...occurrence, lateMs });
      }
      // What was missed is reported first, so a record of the tick reads in
      // the order the times came due.
      if (missed.length && options.onMissed) {
        try {
          options.onMissed(missed);
        } catch (err) {
          console.error(`[CronScheduler] Job "${id}" missed-occurrence handler threw:`, err);
        }
      }
      for (const occurrence of due) {
        remember(occurrence.key);
        run(occurrence);
      }
      // A minute that clocks skipped when they jumped forward fires once,
      // right after the jump. Only while ticking normally: a jump during a
      // long stall is part of what was missed.
      if (current - from <= 2) {
        for (let minute = from + 1; minute <= current; minute++) {
          const shifted = skippedOccurrence(parsed, minute * 60_000);
          if (shifted && !fired.has(shifted.key)) {
            remember(shifted.key);
            run({ ...shifted, lateMs: nowMs - shifted.at });
          }
        }
      }
      const job = this.jobs.get(id);
      if (job) job.nextRun = CronScheduler.nextRun(expression, new Date(nowMs))?.getTime() ?? nowMs;
    };

    const handle = setInterval(() => tick(Date.now()), 30_000);

    this.jobs.set(id, {
      id,
      expression,
      callback,
      lastRun: null,
      nextRun: nextRun.getTime(),
      handle,
      tick,
    });

    console.log(`[CronScheduler] Scheduled job "${id}" (${expression}), next run: ${nextRun.toISOString()}`);
  }

  /** Evaluate a job as of `nowMs` without waiting for its interval. */
  runDue(id: string, nowMs = Date.now()): void {
    this.jobs.get(id)?.tick?.(nowMs);
  }

  /**
   * Cancel a specific scheduled job.
   */
  cancel(id: string): void {
    const job = this.jobs.get(id);
    if (job) {
      clearInterval(job.handle);
      this.jobs.delete(id);
      console.log(`[CronScheduler] Cancelled job "${id}"`);
    }
  }

  /**
   * Cancel all scheduled jobs.
   */
  cancelAll(): void {
    for (const job of this.jobs.values()) {
      clearInterval(job.handle);
    }
    this.jobs.clear();
    console.log('[CronScheduler] All jobs cancelled');
  }

  /**
   * Returns info about all active jobs (without the handle or callback).
   */
  getJobs(): CronJobInfo[] {
    return Array.from(this.jobs.values()).map(({ id, expression, lastRun, nextRun }) => ({
      id,
      expression,
      lastRun,
      nextRun,
    }));
  }
}

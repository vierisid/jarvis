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

export type CronJob = {
  id: string;
  expression: string;
  callback: () => void;
  lastRun: number | null;
  nextRun: number;
  handle: ReturnType<typeof setInterval>;
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
    const trimmed = part.trim();

    // Wildcard: *
    if (trimmed === '*') {
      for (let i = min; i <= max; i++) values.add(i);
      continue;
    }

    // Step: */n or start/n
    if (trimmed.includes('/')) {
      const [rangeStr, stepStr] = trimmed.split('/');
      const step = parseInt(stepStr!, 10);
      if (isNaN(step) || step <= 0) throw new Error(`Invalid step in cron field: "${trimmed}"`);

      let rangeMin = min;
      let rangeMax = max;

      if (rangeStr !== '*') {
        if (rangeStr!.includes('-')) {
          const [a, b] = rangeStr!.split('-').map(s => parseInt(s, 10));
          rangeMin = a!;
          rangeMax = b!;
        } else {
          rangeMin = parseInt(rangeStr!, 10);
        }
      }

      for (let i = rangeMin; i <= rangeMax; i += step) values.add(i);
      continue;
    }

    // Range: a-b
    if (trimmed.includes('-')) {
      const [a, b] = trimmed.split('-').map(s => parseInt(s, 10));
      if (isNaN(a!) || isNaN(b!)) throw new Error(`Invalid range in cron field: "${trimmed}"`);
      for (let i = a!; i <= b!; i += 1) values.add(i);
      continue;
    }

    // Literal value
    const val = parseInt(trimmed, 10);
    if (isNaN(val)) throw new Error(`Invalid value in cron field: "${trimmed}"`);
    values.add(val);
  }

  return Array.from(values).sort((a, b) => a - b);
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

  return {
    minutes: parseField(minField!, 0, 59),
    hours: parseField(hourField!, 0, 23),
    daysOfMonth: parseField(domField!, 1, 31),
    months: parseField(monthField!, 1, 12),
    daysOfWeek: parseField(dowField!, 0, 6),  // 0 = Sunday
  };
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
  };
}

/**
 * Timestamp of the next local midnight in the cron timezone. DST-safe: lands
 * by wall-clock arithmetic, then snaps until the wall clock reads 00:xx.
 */
function startOfNextLocalDay(ts: number): number {
  let candidate = ts;
  for (let i = 0; i < 4; i++) {
    const wc = wallClock(new Date(candidate));
    const minutesIntoDay = wc.hour * 60 + wc.minute;
    if (candidate !== ts && wc.hour === 0) return candidate;
    candidate += (24 * 60 - minutesIntoDay) * 60_000;
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
      const { minutes, hours, daysOfMonth, months, daysOfWeek } = parseExpression(expression);

      const { minute, hour, dom, month, dow } = wallClock(date);

      return (
        minutes.includes(minute) &&
        hours.includes(hour) &&
        daysOfMonth.includes(dom) &&
        months.includes(month) &&
        daysOfWeek.includes(dow)
      );
    } catch {
      return false;
    }
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
   * Uses setInterval to check every 30 seconds whether the expression matches.
   */
  schedule(id: string, expression: string, callback: () => void): void {
    if (this.jobs.has(id)) {
      this.cancel(id);
    }

    // Sub-minute path: `@every <n>(s|m|h)`. Use setInterval directly so the
    // trigger fires at the requested cadence instead of being clamped to the
    // 1-minute granularity of the standard cron loop.
    const everyMs = parseEveryExpression(expression);
    if (everyMs !== null) {
      const fireAt = Date.now() + everyMs;
      const handle = setInterval(() => {
        const job = this.jobs.get(id);
        if (job) {
          job.lastRun = Date.now();
          job.nextRun = Date.now() + everyMs;
        }
        try {
          callback();
        } catch (err) {
          console.error(`[CronScheduler] Job "${id}" threw an error:`, err);
        }
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
    parseExpression(expression);

    const nextRun = CronScheduler.nextRun(expression);
    if (!nextRun) {
      throw new Error(`Cron expression "${expression}" has no upcoming execution times`);
    }

    let lastTickMinute = -1;

    const handle = setInterval(() => {
      const now = new Date();
      // Epoch minute -- monotonically increasing across years/DST/leap
      // seconds, unlike the old `year*525960 + ...` formula whose
      // coefficients (a year isn't exactly 525960 minutes) only happen
      // to dedupe correctly because intra-month days never overflow.
      const currentMinute = Math.floor(now.getTime() / 60_000);

      // Only evaluate once per minute
      if (currentMinute === lastTickMinute) return;
      lastTickMinute = currentMinute;

      if (CronScheduler.matches(expression, now)) {
        const job = this.jobs.get(id);
        if (job) {
          job.lastRun = Date.now();
          const next = CronScheduler.nextRun(expression, now);
          job.nextRun = next ? next.getTime() : Date.now();
        }
        try {
          callback();
        } catch (err) {
          console.error(`[CronScheduler] Job "${id}" threw an error:`, err);
        }
      }
    }, 30_000);

    this.jobs.set(id, {
      id,
      expression,
      callback,
      lastRun: null,
      nextRun: nextRun.getTime(),
      handle,
    });

    console.log(`[CronScheduler] Scheduled job "${id}" (${expression}), next run: ${nextRun.toISOString()}`);
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

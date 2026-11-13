/**
 * Schedules in words, and the simple schedule shapes the editor can write.
 *
 * The stored format is untouched: a schedule trigger keeps `cron_expression`,
 * `timezone` and `dst_policy` in its input. This module only reads a cron
 * expression for display and builds one for the common cases (every day,
 * weekdays, chosen days, at a time). Anything it cannot say plainly falls back
 * to the raw expression, and the editor keeps "Custom (cron)" for those.
 */

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

/** Names of the days of the week, Sunday first (cron numbering). */
export function dayName(day: number): string {
  return DAY_NAMES[day] ?? "";
}

function joinWords(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

export function formatTime(hour: number, minute: number): string {
  return `${hour}:${String(minute).padStart(2, "0")}`;
}

/**
 * Expand one cron field to a sorted list of numbers. Null when it uses anything
 * beyond numbers, lists, ranges and steps: the scheduler (src/lib/cron-scheduler.ts)
 * accepts only those, so day names, `?`, `L`, `W` and `#` never fire there and
 * must not read as a schedule here.
 */
function expandField(field: string, min: number, max: number): number[] | null {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const stepMatch = /^(.+?)\/(\d+)$/.exec(part);
    const step = stepMatch ? Number(stepMatch[2]) : 1;
    const base = stepMatch ? stepMatch[1]! : part;
    if (step < 1) return null;
    let from: number;
    let to: number;
    if (base === "*") { from = min; to = max; }
    else {
      const range = /^(\d+)(?:-(\d+))?$/.exec(base);
      if (!range) return null;
      from = Number(range[1]);
      to = range[2] === undefined ? (stepMatch ? max : from) : Number(range[2]);
    }
    if (!Number.isInteger(from) || !Number.isInteger(to) || from > to) return null;
    for (let v = from; v <= to; v += step) out.add(v);
  }
  const values = [...out];
  if (values.some((v) => v < min || v > max)) return null;
  return values.sort((a, b) => a - b);
}

interface CronFields {
  minute: string;
  hour: string;
  dom: string;
  month: string;
  dow: string;
}

function splitCron(expression: string): CronFields | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, dom, month, dow] = parts as [string, string, string, string, string];
  return { minute, hour, dom, month, dow };
}

/** Days of the week a cron day-of-week field names (0 = Sunday, 7 folded to 0), or null. */
function weekdays(field: string): number[] | null {
  const days = expandField(field, 0, 7);
  return days ? [...new Set(days.map((d) => (d === 7 ? 0 : d)))].sort((a, b) => a - b) : null;
}

const isNumber = (field: string): boolean => /^\d+$/.test(field);

function dayPhrase(days: number[]): string {
  if (days.length === 7) return "Every day";
  if (days.join() === "1,2,3,4,5") return "Every weekday";
  return `Every ${joinWords(mondayFirst(days).map(dayName))}`;
}

/** Monday first reads naturally. */
const mondayFirst = (days: number[]): number[] => [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));

/**
 * " on weekdays" or " on Mondays and Fridays" for an interval limited to some
 * days of the week; "" for every day; null when the day fields say more than that.
 */
function onDays(f: CronFields): string | null {
  if (f.dom !== "*" || f.month !== "*") return null;
  if (f.dow === "*") return "";
  const days = weekdays(f.dow);
  if (!days || !days.length) return null;
  if (days.length === 7) return "";
  if (days.join() === "1,2,3,4,5") return " on weekdays";
  return ` on ${joinWords(mondayFirst(days).map((d) => `${dayName(d)}s`))}`;
}

/** A cron expression in words, or null when it is not one of the shapes people commonly write. */
export function cronToWords(expression: string): string | null {
  const f = splitCron(expression);
  if (!f) return null;
  // Intervals limited at most to some days of the week ("Every hour on weekdays").
  const on = onDays(f);

  // Intervals: every minute, every N minutes, every hour, every N hours.
  if (f.hour === "*" && on !== null) {
    if (f.minute === "*") return `Every minute${on}`;
    const step = /^\*\/(\d+)$/.exec(f.minute);
    if (step) {
      const every = Number(step[1]);
      if (every === 1) return `Every minute${on}`;
      // A step that does not divide 60 restarts at the top of every hour: */59 fires at :00 and :59.
      if (60 % every === 0) return `Every ${every} minutes${on}`;
      const minutes = expandField(f.minute, 0, 59);
      return minutes ? `At ${minutes.length === 1 ? "minute" : "minutes"} ${joinWords(minutes.map(String))} of every hour${on}` : null;
    }
    if (isNumber(f.minute) && Number(f.minute) <= 59) return `${f.minute === "0" ? "Every hour" : `Every hour at minute ${Number(f.minute)}`}${on}`;
    return null;
  }
  const hourStep = /^\*\/(\d+)$/.exec(f.hour);
  if (hourStep && on !== null && isNumber(f.minute) && Number(f.minute) <= 59) {
    const n = Number(hourStep[1]);
    const minute = Number(f.minute);
    if (n === 1 || (n > 0 && 24 % n === 0)) {
      const every = n === 1 ? "Every hour" : `Every ${n} hours`;
      return `${minute === 0 ? every : `${every} at minute ${minute}`}${on}`;
    }
    // A step that does not divide 24 restarts at midnight, so say the real times.
    const hours = expandField(f.hour, 0, 23);
    if (hours && hours.length > 1) {
      const clock = (h: number): string => `${String(h).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
      return `Every ${n} hours from ${minute === 0 ? "midnight" : clock(0)} (${hours.map(clock).join(", ")})${on}`;
    }
  }

  // Everything else fires at fixed times of day.
  if (!isNumber(f.minute) || Number(f.minute) > 59 || f.month !== "*") return null;
  const hours = expandField(f.hour, 0, 23);
  if (!hours || !hours.length || hours.length > 6) return null;
  const at = `at ${joinWords(hours.map((h) => formatTime(h, Number(f.minute))))}`;

  if (f.dom === "*") {
    const days = f.dow === "*" ? [0, 1, 2, 3, 4, 5, 6] : weekdays(f.dow);
    return days && days.length ? `${dayPhrase(days)} ${at}` : null;
  }
  if (f.dow !== "*") return null;
  const dom = expandField(f.dom, 1, 31);
  if (!dom || !dom.length || dom.length > 6) return null;
  // Days 29 to 31 are skipped in months that lack them.
  const short = dom.filter((d) => d > 28);
  const note = !short.length ? "" : dom.length === 1 ? " of months that have one," : ` (${joinWords(short.map(String))} only in months that have ${short.length === 1 ? "it" : "them"}),`;
  return `Monthly on ${dom.length === 1 ? "day" : "days"} ${joinWords(dom.map(String))}${note} ${at}`;
}

export const SCHEDULE_PIECE = "schedule";
/** The catalog schedule piece. The built-in "schedule" name above is an alias that stores a cron expression directly. */
export const CATALOG_SCHEDULE_PIECE = "@activepieces/piece-schedule";

/** True for a trigger from either schedule name. */
export function isScheduleSettings(settings: { pieceName?: string } | undefined): boolean {
  return settings?.pieceName === SCHEDULE_PIECE || settings?.pieceName === CATALOG_SCHEDULE_PIECE;
}

const missing = (value: unknown): boolean => value === undefined || value === null || value === "";

/**
 * A dropdown number as the schedule piece reads it (`validateHours` and friends
 * in its common/index.ts): anything but an integer becomes 0, then it is
 * clamped. The engine does not coerce dropdown values, so a stored "9" fires at
 * hour 0, and the words must say so. Null when nothing is stored.
 */
const pieceNumber = (value: unknown, min: number, max: number): number | null =>
  missing(value) ? null : typeof value === "number" && Number.isInteger(value) ? Math.min(Math.max(value, min), max) : 0;

/**
 * The cron expression a catalog schedule trigger turns its inputs into, built
 * exactly as the piece's onEnable builds it (every_x_minutes, every_hour,
 * every_day, every_week, every_month, cron_expression), so the words describe
 * what fires. Empty when a required input is not filled in.
 */
function catalogCron(settings: { triggerName?: string; input?: Record<string, unknown> }): string {
  const input = settings.input ?? {};
  const hour = pieceNumber(input["hour_of_the_day"], 0, 23);
  // The piece tests the checkbox for truthiness.
  const weekends = Boolean(input["run_on_weekends"]);
  switch (settings.triggerName) {
    case "cron_expression": {
      const value = input["cronExpression"];
      return typeof value === "string" ? value.trim() : "";
    }
    case "every_x_minutes": {
      const minutes = input["minutes"];
      return missing(minutes) ? "" : `*/${String(minutes)} * * * *`;
    }
    case "every_hour": return weekends ? "0 * * * *" : "0 * * * 1-5";
    case "every_day": return hour === null ? "" : `0 ${hour} * * ${weekends ? "*" : "1-5"}`;
    case "every_week": {
      const day = pieceNumber(input["day_of_the_week"], 0, 6);
      return hour === null || day === null ? "" : `0 ${hour} * * ${day}`;
    }
    case "every_month": {
      const day = pieceNumber(input["day_of_the_month"], 0, 31);
      return hour === null || day === null ? "" : `0 ${hour} ${day} * *`;
    }
    default: return "";
  }
}

/** The cron expression a schedule step carries, wherever the stored input keeps it. */
export function scheduleCron(input: Record<string, unknown> | undefined): string {
  for (const key of ["cron_expression", "cronExpression", "expression"]) {
    const value = input?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/**
 * The zone a schedule really runs in when a person chose one. A pre-filled
 * zone nobody chose is not used by the scheduler (see schedule-zone.ts), so it
 * is not shown as the schedule's zone either.
 */
export function chosenZoneOf(settings: { input?: Record<string, unknown>; chosenTimezone?: string } | undefined): string | undefined {
  const zone = settings?.input?.["timezone"];
  return typeof zone === "string" && zone && settings?.chosenTimezone === zone ? zone : undefined;
}

interface ScheduleSettings {
  pieceName?: string;
  triggerName?: string;
  input?: Record<string, unknown>;
  chosenTimezone?: string;
}

/**
 * The one place a schedule becomes words, for the trigger card, the trigger
 * panel and the summary. "Every weekday at 9:00 (Europe/Rome)". Falls back to
 * the raw expression, or says nothing is set yet.
 *
 * The zone follows the trigger manager (src/workflows/runner/triggers/manager.ts):
 * both schedule names run in their stored zone only when a person chose it, and
 * otherwise in Jarvis's zone, shown as no zone. The catalog piece's hourly and
 * every-few-minutes triggers report UTC whatever is stored, so only a chosen UTC
 * is used for them.
 */
export function describeSchedule(settings: ScheduleSettings | undefined): string {
  const catalog = settings?.pieceName === CATALOG_SCHEDULE_PIECE;
  const cron = catalog ? catalogCron(settings) : scheduleCron(settings?.input);
  if (!cron) return "On a schedule that is not set yet";
  const words = cronToWords(cron) ?? `On a custom schedule (${cron})`;
  const chosen = chosenZoneOf(settings);
  const fixedUtc = catalog && (settings?.triggerName === "every_x_minutes" || settings?.triggerName === "every_hour");
  const zone = fixedUtc && chosen !== "UTC" ? undefined : chosen;
  return zone ? `${words} (${zone})` : words;
}

/* ------------------------------------------------------------ simple shapes */

export type SimpleScheduleMode = "daily" | "weekdays" | "days";

export interface SimpleSchedule {
  mode: SimpleScheduleMode;
  hour: number;
  minute: number;
  /** Days of the week for "days" (0 = Sunday). Always 1 to 6 days. */
  days: number[];
}

/** The simple shape a cron expression has, or null when it needs the Custom (cron) editor. */
export function parseSimpleCron(expression: string): SimpleSchedule | null {
  const f = splitCron(expression);
  if (!f || !isNumber(f.minute) || !isNumber(f.hour) || f.dom !== "*" || f.month !== "*") return null;
  const minute = Number(f.minute);
  const hour = Number(f.hour);
  if (minute > 59 || hour > 23) return null;
  const days = f.dow === "*" ? [0, 1, 2, 3, 4, 5, 6] : weekdays(f.dow);
  if (!days || !days.length) return null;
  if (days.length === 7) return { mode: "daily", hour, minute, days: [] };
  if (days.join() === "1,2,3,4,5") return { mode: "weekdays", hour, minute, days: [] };
  return { mode: "days", hour, minute, days };
}

export function buildSimpleCron(schedule: SimpleSchedule): string {
  const head = `${schedule.minute} ${schedule.hour} * *`;
  if (schedule.mode === "daily") return `${head} *`;
  if (schedule.mode === "weekdays") return `${head} 1-5`;
  const days = [...new Set(schedule.days)].sort((a, b) => a - b);
  return days.length && days.length < 7 ? `${head} ${days.join(",")}` : `${head} *`;
}

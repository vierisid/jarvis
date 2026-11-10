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
const DAY_ALIASES: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

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

/** Expand one cron field to a sorted list of numbers. Null when it uses anything beyond lists, ranges and steps. */
function expandField(field: string, min: number, max: number, aliases?: Record<string, number>): number[] | null {
  const out = new Set<number>();
  for (const part of field.toLowerCase().split(",")) {
    const stepMatch = /^(.+?)\/(\d+)$/.exec(part);
    const step = stepMatch ? Number(stepMatch[2]) : 1;
    const base = stepMatch ? stepMatch[1]! : part;
    if (step < 1) return null;
    let from: number;
    let to: number;
    if (base === "*") { from = min; to = max; }
    else {
      const range = /^([a-z0-9]+)(?:-([a-z0-9]+))?$/.exec(base);
      if (!range) return null;
      const num = (token: string): number => (aliases && token in aliases ? aliases[token]! : /^\d+$/.test(token) ? Number(token) : NaN);
      from = num(range[1]!);
      to = range[2] === undefined ? (stepMatch ? max : from) : num(range[2]);
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
  return { minute, hour, dom: dom === "?" ? "*" : dom, month, dow: dow === "?" ? "*" : dow };
}

/** Days of the week a cron day-of-week field names (0 = Sunday, 7 folded to 0), or null. */
function weekdays(field: string): number[] | null {
  const days = expandField(field, 0, 7, DAY_ALIASES);
  return days ? [...new Set(days.map((d) => (d === 7 ? 0 : d)))].sort((a, b) => a - b) : null;
}

const isNumber = (field: string): boolean => /^\d+$/.test(field);

function dayPhrase(days: number[]): string {
  if (days.length === 7) return "Every day";
  if (days.join() === "1,2,3,4,5") return "Every weekday";
  if (days.join() === "0,6") return "Every weekend";
  // Monday first reads naturally.
  const ordered = [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
  return `Every ${joinWords(ordered.map(dayName))}`;
}

/** A cron expression in words, or null when it is not one of the shapes people commonly write. */
export function cronToWords(expression: string): string | null {
  const f = splitCron(expression);
  if (!f) return null;
  const everyDay = f.dom === "*" && f.month === "*" && f.dow === "*";

  // Intervals: every minute, every N minutes, every hour, every N hours.
  if (f.hour === "*" && everyDay) {
    if (f.minute === "*") return "Every minute";
    const step = /^\*\/(\d+)$/.exec(f.minute);
    if (step) return Number(step[1]) === 1 ? "Every minute" : `Every ${Number(step[1])} minutes`;
    if (isNumber(f.minute) && Number(f.minute) <= 59) return f.minute === "0" ? "Every hour" : `Every hour at minute ${Number(f.minute)}`;
    return null;
  }
  const hourStep = /^\*\/(\d+)$/.exec(f.hour);
  if (hourStep && everyDay && isNumber(f.minute) && Number(f.minute) <= 59) {
    const every = Number(hourStep[1]) === 1 ? "Every hour" : `Every ${Number(hourStep[1])} hours`;
    return f.minute === "0" ? every : `${every} at minute ${Number(f.minute)}`;
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
  return `Monthly on ${dom.length === 1 ? "day" : "days"} ${joinWords(dom.map(String))} ${at}`;
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

/** "Every weekday at 9:00 (Europe/Rome)". Falls back to the raw expression, or says nothing is set yet. */
export function describeSchedule(settings: { input?: Record<string, unknown>; chosenTimezone?: string } | undefined): string {
  const cron = scheduleCron(settings?.input);
  if (!cron) return "On a schedule that is not set yet";
  const words = cronToWords(cron) ?? `On a custom schedule (${cron})`;
  const zone = chosenZoneOf(settings);
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

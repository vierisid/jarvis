/**
 * Which time zone a workflow schedule runs in.
 *
 * A schedule step's own zone (`settings.input.timezone`) is used only when a
 * person chose it. Everything else -- no zone, or a zone some default put
 * there (the schedule piece pre-fills one, its hourly triggers hard-code
 * UTC) -- runs in Jarvis's configured time zone, else this machine's, as
 * every schedule did before steps could carry a zone.
 *
 * "Chosen" is recorded next to the input, not inside it, so pieces never see
 * it: `settings.chosenTimezone` holds the zone the person picked, and the
 * step's zone is honoured only while it still equals that. The editor writes
 * it when a person picks a zone, the composer when the request names one.
 * A schedule saved before the marker existed carries none, so it keeps
 * firing at the times it always did: no schedule moves on upgrade. A zone
 * changed later through the API without the marker is shown, not used.
 */

import { CronScheduler, getCronTimezone } from "../../../lib/cron-scheduler";
import type { PieceInputSchema } from "../../runtime/piece-input";

/** Settings key (sibling of `input`) naming the zone a person picked for this schedule step. */
export const CHOSEN_TIMEZONE_KEY = "chosenTimezone";

/** Jarvis's configured zone, else this machine's: where every schedule without a chosen zone runs. */
export function defaultScheduleZone(): string {
  return getCronTimezone() ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function inputOf(settings: unknown): Record<string, unknown> | null {
  if (!settings || typeof settings !== "object") return null;
  const input = (settings as { input?: unknown }).input;
  return input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : null;
}

/** Names of UTC itself. Bun's Intl keeps them apart (`Etc/UTC` stays `Etc/UTC`), so they are folded here. */
const UTC_ALIASES = new Set(["utc", "etc/utc", "etc/uct", "uct", "gmt", "etc/gmt", "etc/gmt0", "etc/gmt+0", "etc/gmt-0", "gmt0", "gmt+0", "gmt-0",
  "etc/greenwich", "greenwich", "universal", "etc/universal", "zulu", "etc/zulu"]);

/** The canonical IANA name of `zone` (every alias of UTC is `UTC`), or null when it is not a time zone. */
export function canonicalZone(zone: unknown): string | null {
  if (typeof zone !== "string" || !zone.trim()) return null;
  let name: string;
  try { name = new Intl.DateTimeFormat("en-US", { timeZone: zone.trim() }).resolvedOptions().timeZone; } catch { return null; }
  return UTC_ALIASES.has(name.toLowerCase()) ? "UTC" : name;
}

/** The zone the step names in `input.timezone`, chosen or not; undefined when it names none. */
export function statedScheduleZone(settings: unknown): unknown {
  const zone = inputOf(settings)?.timezone;
  return zone === undefined || zone === null || zone === "" ? undefined : zone;
}

/** The step's zone when a person chose it; undefined means the schedule runs in `defaultScheduleZone()`. */
export function chosenScheduleZone(settings: unknown): string | undefined {
  const zone = statedScheduleZone(settings);
  if (typeof zone !== "string") return undefined;
  return (settings as Record<string, unknown>)[CHOSEN_TIMEZONE_KEY] === zone ? zone : undefined;
}

/** The zone the step's schedule fires in. */
export function effectiveScheduleZone(settings: unknown): string {
  return chosenScheduleZone(settings) ?? defaultScheduleZone();
}

/**
 * A schedule names `statedZone` but runs in Jarvis's zone, because nobody
 * chose it: say so where the trigger list shows it, unless it fires at the
 * same moments in both zones (hourly between whole-hour zones). Its next
 * firing times, now and half a year on (the other side of daylight saving),
 * are read in the stated zone: half-hour zones and schedules tied to an hour,
 * a day or a date differ there. Callers pass only a zone that is not used.
 * `pickable` is false for a trigger with no zone to pick (the schedule
 * piece's hourly and every-few-minutes triggers hard-code UTC).
 */
export function scheduleZoneWarning(expression: string, statedZone: unknown, now = Date.now(), pickable = true): string | undefined {
  if (statedZone === undefined || statedZone === null || statedZone === "" || expression.trim().startsWith("@")) return undefined;
  const actual = defaultScheduleZone();
  let stated: string;
  try {
    if (typeof statedZone !== "string" || !statedZone.trim()) throw new Error("not a zone");
    stated = new Intl.DateTimeFormat("en-US", { timeZone: statedZone.trim() }).resolvedOptions().timeZone;
  } catch { return `This schedule names an unknown time zone "${String(statedZone)}"; it runs in ${actual}.`; }
  if (stated === actual) return undefined;
  const year = 366 * 24 * 60 * 60_000;
  const upcoming = [now, now + year / 2].flatMap((from) => CronScheduler.occurrencesBetween(expression, from, from + year, 8));
  if (upcoming.every((o) => CronScheduler.matchesIn(expression, new Date(o.at), stated))) return undefined;
  return `This schedule names ${stated}, but nobody chose that zone for it, so it runs in Jarvis's time zone (${actual}): "${expression}" fires at that time in ${actual}.${pickable ? " Pick the zone in the editor to use it." : ""}`;
}

/** The bundled schedule piece (`@activepieces/piece-schedule`). */
export const isSchedulePieceName = (pieceName: unknown): boolean =>
  typeof pieceName === "string" && /(^|\/)piece-schedule$/.test(pieceName);

/**
 * The schedule piece's trigger inputs as the editor should pre-fill them: its
 * `timezone` default is Jarvis's zone instead of the piece's UTC, so a new
 * "9:00" schedule means 9:00 where Jarvis is. The pre-filled zone is still a
 * default nobody chose; picking a zone in the editor marks it chosen.
 */
export function withScheduleZoneDefault(pieceName: string, schema: PieceInputSchema | null | undefined, zone = defaultScheduleZone()): PieceInputSchema | null {
  if (!schema) return schema ?? null;
  if (!isSchedulePieceName(pieceName) || !schema.fields.some((f) => f.name === "timezone")) return schema;
  return {
    ...schema,
    fields: schema.fields.map((f) => {
      if (f.name !== "timezone") return f;
      const options = f.options && !f.options.some((o) => o.value === zone) ? [{ value: zone, label: zone }, ...f.options] : f.options;
      return { ...f, default: zone, ...(options ? { options } : {}) };
    }),
  };
}

/**
 * Plain schedule editor for the built-in schedule trigger: every day,
 * weekdays or chosen days, at a time, in a timezone. It writes the existing
 * schedule fields (`cron_expression`, `timezone`) through `onSetInput`, so the
 * stored format and the schedule piece are unchanged. "Custom (cron)" keeps
 * the raw expression for anything else.
 */

import React, { useMemo, useState } from "react";
import {
  buildSimpleCron,
  chosenZoneOf,
  cronToWords,
  dayName,
  parseSimpleCron,
  scheduleCron,
  type SimpleSchedule,
  type SimpleScheduleMode,
} from "./schedule-words";

type Mode = SimpleScheduleMode | "custom";

const MODE_LABELS: Array<[Mode, string]> = [
  ["daily", "Every day"],
  ["weekdays", "Weekdays"],
  ["days", "Specific days"],
  ["custom", "Custom (cron)"],
];
/** Monday first, as people read a week. Values are cron day numbers (0 = Sunday). */
const WEEK: number[] = [1, 2, 3, 4, 5, 6, 0];
const DEFAULT_TIME = { hour: 9, minute: 0 };
const FALLBACK_ZONES = ["UTC", "Europe/London", "Europe/Rome", "Europe/Paris", "Europe/Berlin", "America/New_York", "America/Chicago", "America/Los_Angeles", "Asia/Tokyo", "Asia/Singapore", "Australia/Sydney"];

function timeZones(): string[] {
  try {
    const zones = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone");
    if (zones?.length) return zones.includes("UTC") ? zones : ["UTC", ...zones];
  } catch { /* an older browser: use the short list */ }
  return FALLBACK_ZONES;
}

const pad = (n: number): string => String(n).padStart(2, "0");

export function ScheduleEditor({
  input,
  chosenTimezone,
  onSetInput,
}: {
  input: Record<string, unknown>;
  /** `settings.chosenTimezone`: the stored zone is used only while it equals this. */
  chosenTimezone?: string;
  onSetInput: (key: string, value: unknown) => void;
}): React.ReactElement {
  const cron = scheduleCron(input);
  const simple = cron ? parseSimpleCron(cron) : null;
  // A new schedule has no expression yet: start on the simple editor. An expression
  // the simple editor cannot express opens as Custom, and stays there while edited.
  const [forcedCustom, setForcedCustom] = useState(false);
  const mode: Mode | "" = forcedCustom ? "custom" : !cron ? "" : simple ? simple.mode : "custom";
  const time = simple ?? { ...DEFAULT_TIME, mode: "daily" as const, days: [] };
  const stored = typeof input["timezone"] === "string" ? (input["timezone"] as string) : "";
  // The picker shows the zone the schedule really runs in: a stored zone nobody
  // chose is not used (schedule-zone.ts), so it reads as the Jarvis default.
  const zone = chosenZoneOf({ input, ...(chosenTimezone !== undefined ? { chosenTimezone } : {}) }) ?? "";
  const zones = useMemo(() => (stored && !timeZones().includes(stored) ? [stored, ...timeZones()] : timeZones()), [stored]);
  const words = cron ? cronToWords(cron) : null;

  function write(next: SimpleSchedule): void {
    onSetInput("cron_expression", buildSimpleCron(next));
  }
  function pickMode(next: Mode): void {
    if (next === "custom") {
      setForcedCustom(true);
      return;
    }
    setForcedCustom(false);
    write({ mode: next, hour: time.hour, minute: time.minute, days: next === "days" ? (simple?.days.length ? simple.days : [1]) : [] });
  }
  function toggleDay(day: number): void {
    const days = time.days.includes(day) ? time.days.filter((d) => d !== day) : [...time.days, day];
    if (!days.length || days.length === 7) return; // "Specific days" needs 1 to 6 days
    write({ ...time, mode: "days", days });
  }
  function setTime(value: string): void {
    const match = /^(\d{1,2}):(\d{2})/.exec(value);
    if (!match) return;
    write({ ...time, mode: time.mode, hour: Number(match[1]), minute: Number(match[2]) });
  }

  return (
    <div className="wf-schedule">
      <label className="wf-props__field">
        <span className="wf-props__field-label">Repeats</span>
        <select value={mode} onChange={(e) => e.target.value && pickMode(e.target.value as Mode)} aria-label="Repeats">
          {mode === "" ? <option value="" disabled>Choose when</option> : null}
          {MODE_LABELS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>

      {mode === "days" ? (
        <div className="wf-props__field" role="group" aria-label="Days of the week">
          <span className="wf-props__field-label">Days</span>
          <div className="wf-schedule__days">
            {WEEK.map((day) => (
              <label key={day} className="wf-schedule__day">
                <input type="checkbox" checked={time.days.includes(day)} onChange={() => toggleDay(day)} />
                {dayName(day).slice(0, 3)}
              </label>
            ))}
          </div>
        </div>
      ) : null}

      {mode === "custom" ? (
        <label className="wf-props__field">
          <span className="wf-props__field-label">Cron expression</span>
          <input
            type="text"
            value={cron}
            placeholder="30 8 * * 5"
            onChange={(e) => onSetInput("cron_expression", e.target.value)}
            aria-label="Cron expression"
          />
          <span className="wf-props__field-help">Minute, hour, day of month, month, day of week, as numbers (Sunday is 0). Example: 30 8 * * 5 is Fridays at 8:30; 0 17 LW * * is the last weekday of each month at 17:00.</span>
        </label>
      ) : (
        <label className="wf-props__field">
          <span className="wf-props__field-label">At</span>
          <input type="time" value={`${pad(time.hour)}:${pad(time.minute)}`} onChange={(e) => setTime(e.target.value)} aria-label="Time of day" />
        </label>
      )}

      <label className="wf-props__field">
        <span className="wf-props__field-label">Timezone</span>
        <select value={zone} onChange={(e) => onSetInput("timezone", e.target.value)} aria-label="Timezone">
          <option value="">Jarvis default</option>
          {zones.map((z) => <option key={z} value={z}>{z}</option>)}
        </select>
        {stored && !zone ? <span className="wf-props__field-help">{stored} is saved but nobody picked it, so this runs in the Jarvis default. Pick it to use it.</span> : null}
      </label>

      <p className="wf-props__hint" role="status">
        {cron ? (words ?? "This expression has no plain-English form.") : "Pick when it should run."}
      </p>
    </div>
  );
}

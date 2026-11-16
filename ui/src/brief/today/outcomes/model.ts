import type { BriefMeasurement, BriefOutcome } from "../../../../../src/brief/contracts";
import { isBriefCapabilityEnabled } from "../../../../../src/brief/capabilities";
import type { BriefViewPort } from "../../contracts";

/** F-16 supplies aggregates and their evidence. This view never sums runs itself, interprets
 * goal scores, or subtracts engine duration to manufacture time saved. Time figures built from
 * runs arrive qualified `estimated` and are labelled so. */
export interface OutcomeSummary {
  window: BriefOutcome["window"];
  today: BriefMeasurement | null;
  week: BriefMeasurement | null;
  /** Plain-words basis of `today` and `week`, e.g. "14 runs x about 12 min. Estimated from the workflow's steps." */
  todayBasis?: string | null;
  weekBasis?: string | null;
  days: readonly { id: string; label: string; current: boolean; time: BriefMeasurement | null; basis?: string | null;
    /** A day that has not started: blank, never a zero or an unknown. */
    future?: boolean;
    /** Full date for the tooltip when `label` is short. */
    title?: string }[];
  /** Stable chart scale for this window, in minutes. Overflow is explicitly marked. */
  chartMaxMinutes: number;
  goal: {
    goalId: string;
    title: string;
    progress: BriefMeasurement | null;
    change: BriefMeasurement | null;
    changeLabel: string;
    progressLabel: string;
  } | null;
  coverage: "complete" | "partial";
  /** Concise, sanitized explanation of baselines/attribution supplied by the owner. */
  basis: string;
}
export interface OutcomeBinding<T = OutcomeSummary> extends BriefViewPort<T> { capabilities?: unknown }

export function outcomeView<T>(mode: "live" | "preview", binding?: OutcomeBinding<T>): OutcomeBinding<T> {
  if (!binding || (mode === "preview" && binding.source !== "fixture") || (mode === "live" && (binding.source !== "live"
    || !isBriefCapabilityEnabled(binding.capabilities, "outcomes") || !isBriefCapabilityEnabled(binding.capabilities, "goalMeasurements")))) {
    return { source: mode === "live" ? "live" : "fixture", state: { status: "unavailable", reason: "Outcome evidence is not available yet." } };
  }
  return binding;
}

/** Display guard, not an evaluator of whether the underlying evidence is sufficient. */
function complete(measurement: BriefMeasurement | null | undefined): measurement is BriefMeasurement {
  return !!measurement && Number.isFinite(measurement.value) && Number.isFinite(new Date(measurement.asOf).getTime())
    && !!measurement.unit.trim() && measurement.provenance.length > 0;
}
/** Goal figures are measured or reported by the owner; an estimate never qualifies one. */
export function qualified(measurement: BriefMeasurement | null | undefined): measurement is BriefMeasurement {
  return complete(measurement) && ["measured", "user_reported"].includes(measurement.qualification);
}
/** Time may also be `estimated` (counted runs times assumed minutes), and is then labelled as such, never as measured. */
export function qualifiedTime(measurement: BriefMeasurement | null | undefined): measurement is BriefMeasurement {
  return complete(measurement) && ["measured", "user_reported", "estimated"].includes(measurement.qualification)
    && measurement.unit === "minutes" && measurement.value >= 0
    && measurement.baseline !== null && Number.isFinite(measurement.baseline) && measurement.baseline >= measurement.value;
}
export function qualifiedProgress(measurement: BriefMeasurement | null | undefined): measurement is BriefMeasurement & { target: number } {
  return qualified(measurement) && measurement.value >= 0 && measurement.target !== null
    && Number.isFinite(measurement.target) && measurement.target > 0;
}
export function progressBand(value: number, target: number) {
  const ratio = value / target;
  return ratio < .2 ? "near" : ratio < .4 ? "early" : ratio < .75 ? "middle" : "complete";
}
export function qualificationLabel(measurement: BriefMeasurement) {
  return measurement.qualification === "estimated" ? "Estimated" : measurement.qualification === "user_reported" ? "User reported" : "Measured";
}
export const formatNumber = (value: number) => new Intl.NumberFormat("en", { maximumSignificantDigits: 12 }).format(value);
export function weekTime(value: number) {
  const hours = Math.floor(value / 60), minutes = value % 60;
  return hours ? `${hours}h${minutes ? ` ${formatNumber(minutes)}m` : ""}` : `${formatNumber(minutes)} min`;
}
export function formatAsOf(time: number, timezone: string) {
  if (!Number.isFinite(new Date(time).getTime())) return "Date unavailable";
  try { return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: timezone }).format(time); }
  catch { return new Date(time).toISOString(); }
}

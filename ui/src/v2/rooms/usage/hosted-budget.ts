/**
 * The hosted usage meter, as the Usage room renders it.
 *
 * Pure on purpose — every rule below is a decision that has to hold at a
 * boundary (a null reading, a reset that has already passed, a window at
 * exactly 75%), and the room's own tests cannot reach those through JSX.
 */

export type MeterTone = "mut" | "hold" | "fail";

/** Mirrors the daemon's `HostedUsageMeter` (src/daemon/hosted-usage.ts). */
export interface HostedMeter {
  entitled: boolean;
  blocked: boolean;
  /** null when the control plane could not read the proxy. NEVER render as 0. */
  sessionPct: number | null;
  weekPct: number;
  sessionResetsAt: string;
  weekResetsAt: string;
}

/** Where a window turns from information into a warning. Matches the daemon's
 *  notification threshold, so the banner and the OS notification agree. */
export const WARN_PCT = 75;

export function meterTone(pct: number | null, blocked = false): MeterTone {
  if (blocked || (pct !== null && pct >= 100)) return "fail";
  if (pct !== null && pct >= WARN_PCT) return "hold";
  return "mut";
}

/** Clamped for the BAR only. The label keeps the true number: a proxy that has
 *  overshot its budget should read "104%", not a quietly capped "100%". */
export function barWidthPct(pct: number | null): number {
  if (pct === null) return 0;
  return Math.max(0, Math.min(100, pct));
}

export function formatPct(pct: number | null): string {
  return pct === null ? "unavailable" : `${Math.round(pct)}%`;
}

/**
 * "resets in 2h 14m".
 *
 * A reset in the PAST is normal here rather than a bug: both sides cache the
 * meter for up to a minute, so the boundary can pass while a reading is still
 * being served. It reads as "resetting…" — never as a negative countdown, and
 * never as "resets in 0m", which would look stuck.
 */
export function formatResetIn(resetsAt: string, nowMs: number): string {
  const at = Date.parse(resetsAt);
  if (!Number.isFinite(at)) return "";
  const ms = at - nowMs;
  if (ms <= 0) return "resetting…";
  const mins = Math.floor(ms / 60_000);
  const days = Math.floor(mins / 1_440);
  const hours = Math.floor((mins % 1_440) / 60);
  if (days > 0) return `resets in ${days}d ${hours}h`;
  if (hours > 0) return `resets in ${hours}h ${mins % 60}m`;
  return `resets in ${Math.max(1, mins)}m`;
}

export interface MeterBanner {
  tone: "hold" | "fail";
  text: string;
}

/**
 * The banner above the meter, or null when there is nothing to say.
 *
 * Keyed off `blocked` FIRST, and independently of the percentages. The proxy
 * enforces a rolling 7 days from key creation while we display a Monday-aligned
 * week (docs/LLM.md), so the two can disagree — and when they do, the surface
 * must not claim headroom the proxy is already refusing.
 */
export function bannerFor(meter: HostedMeter | null): MeterBanner | null {
  if (!meter || !meter.entitled) return null;
  if (meter.blocked) {
    return {
      tone: "fail",
      text: "Included AI usage is used up for this window. It resumes when the window resets — the meter below shows when.",
    };
  }
  const hot: string[] = [];
  if (meter.sessionPct !== null && meter.sessionPct >= WARN_PCT) hot.push("this 6-hour window");
  if (meter.weekPct >= WARN_PCT) hot.push("this week");
  if (hot.length === 0) return null;
  return { tone: "hold", text: `You have used over ${WARN_PCT}% of your included AI usage for ${hot.join(" and ")}.` };
}

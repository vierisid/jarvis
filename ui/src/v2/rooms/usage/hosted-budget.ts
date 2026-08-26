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

/**
 * Tone for ONE window's bar, from that window's own number.
 *
 * Deliberately not a function of `blocked`: that flag means the key is switched
 * off (no plan, or a converge that failed part-way), not that this window is
 * full, and painting a 4% bar red because of it tells the user the opposite of
 * what the number says. The block state is the banner's job.
 */
export function meterTone(pct: number | null): MeterTone {
  if (pct !== null && pct >= 100) return "fail";
  if (pct !== null && pct >= WARN_PCT) return "hold";
  return "mut";
}

/** Defensive clamp. The control plane already caps both percentages at 100
 *  (llm-sweeps.ts `Math.min(100, Math.ceil(…))`), so >100 should not arrive;
 *  this keeps a bar inside its track if that ever changes. */
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
 * Note what this CANNOT tell the user: the proxy enforces a rolling 7 days from
 * key creation while we display a Monday-aligned week (docs/LLM.md POC item 1),
 * and nothing reads the proxy's own weekly counter — so a refusal on it shows
 * up here as neither a full bar nor a banner. The chat surface still explains
 * it (src/util/hosted-error.ts); this one stays silent, which is a known gap
 * rather than a claim of headroom.
 */
export function bannerFor(meter: HostedMeter | null): MeterBanner | null {
  if (!meter || !meter.entitled) return null;
  // Blocked is NOT "used up" — see the note in src/daemon/usage-alerts.ts. The
  // control plane sets it for a user with no plan (filtered out above) or a
  // converge gap, so reaching here means a plan whose key is switched off.
  if (meter.blocked) {
    return {
      tone: "fail",
      text: "Your assistant cannot reach its AI models right now. This is being fixed on our side — nothing you need to do.",
    };
  }
  const hot: string[] = [];
  if (meter.sessionPct !== null && meter.sessionPct >= WARN_PCT) hot.push("this 6-hour window");
  if (meter.weekPct >= WARN_PCT) hot.push("this week");
  if (hot.length === 0) return null;
  return { tone: "hold", text: `You have used over ${WARN_PCT}% of your included AI usage for ${hot.join(" and ")}.` };
}

// ─── The hosted gate, as a pure decision ─────────────────────────────────
/**
 * What one answer from `/api/llm/budget` means, and what it does to the strip.
 *
 * Split out of `useHostedBudget` because this is the part that re-litigates a
 * recorded bug — OnboardingWizard.tsx documents a hosted probe that read as
 * self-hosted while it was merely slow, and walked a hosted user through three
 * screens of setup that the server then discarded. There is no DOM in this test
 * suite, so a decision left inside the hook is a decision nothing checks.
 */

export type BudgetProbe =
  | { kind: "self" }
  | { kind: "meter"; meter: HostedMeter }
  | { kind: "unreadable" }
  | { kind: "failed" };

export interface BudgetView {
  state: "unknown" | "hosted" | "self";
  meter: HostedMeter | null;
}

/** 503 is the ONLY answer that means "not a hosted install" — it is the route's
 *  own `hasUsejarvisAi` guard. Everything else is either a reading or a
 *  failure, and a failure is not evidence about which kind of install this is. */
export function classifyBudgetResponse(
  status: number,
  body: { ok?: boolean; meter?: HostedMeter } | null,
): BudgetProbe {
  if (status === 503) return { kind: "self" };
  if (status < 200 || status >= 300) return { kind: "failed" };
  if (body?.ok && body.meter) return { kind: "meter", meter: body.meter };
  return { kind: "unreadable" };
}

export function applyBudgetProbe(prev: BudgetView, probe: BudgetProbe): BudgetView {
  switch (probe.kind) {
    case "self":
      return { state: "self", meter: null };
    case "meter":
      return { state: "hosted", meter: probe.meter };
    case "unreadable":
      // Hosted, but the control plane could not be read. KEEP the last good
      // meter: a minute-old reading beats a strip that flickers empty every
      // time the control plane hiccups.
      return { state: "hosted", meter: prev.meter };
    case "failed":
      // Changes NOTHING — least of all to "self". An unreachable daemon is the
      // slow-probe case from the wizard, and answering it with "self-hosted"
      // hides a hosted user's meter exactly when they need it.
      return prev;
  }
}

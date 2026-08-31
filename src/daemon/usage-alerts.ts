import type { HostedUsageMeter } from './hosted-usage.ts';

/**
 * Warn a hosted tenant BEFORE the proxy starts refusing them.
 *
 * Today the only signal that a window is full is the assistant declining to
 * answer (src/util/hosted-error.ts turns the proxy's 429 into copy that points
 * at a meter). This fires two warnings per window — three-quarters used, and
 * used up — for the 6-hour session window and the week.
 *
 * ## Why the de-duplication is PERSISTENT
 *
 * The windows are hours long and the daemon restarts (upgrades, crashes, a
 * laptop closing). The in-memory `notifiedApprovalIds` set next door is right
 * for approvals, which live minutes; here it would re-notify on every restart,
 * which for a user who leaves a machine on is a notification every time the
 * daemon bounces for six hours.
 *
 * ## Why the flag key contains the window's own reset stamp
 *
 * It self-expires. `usage.notified.session.75.<sessionResetsAt>` cannot match
 * once the window rolls, so a new window notifies again with no clock
 * arithmetic and no cleanup on the critical path — the same bucket-key mechanic
 * `realtime-budget.ts` uses for its month. Old keys are pruned on a hit rather
 * than expired by a timer.
 */

export type UsageWindow = 'session' | 'week';
export type UsageLevel = typeof WARN_PCT | 100;

export interface UsageAlert {
  window: UsageWindow;
  level: UsageLevel;
  /** The settings key that records this alert as delivered. */
  key: string;
  title: string;
  body: string;
}

/** Must match the room's WARN_PCT (ui/.../hosted-budget.ts) — if these drift, a
 *  user gets a notification while the meter still shows a calm bar. */
export const WARN_PCT = 75 as const;

export const FLAG_PREFIX = 'usage.notified.';

export function alertKey(window: UsageWindow, level: UsageLevel, resetsAt: string): string {
  return `${FLAG_PREFIX}${window}.${level}.${resetsAt}`;
}

const WINDOW_LABEL: Record<UsageWindow, string> = {
  session: 'this 6-hour window',
  week: 'this week',
};

function alertFor(window: UsageWindow, level: UsageLevel, resetsAt: string): UsageAlert {
  const label = WINDOW_LABEL[window];
  return {
    window,
    level,
    key: alertKey(window, level, resetsAt),
    title: level === 100 ? 'Included AI usage used up' : 'Included AI usage running low',
    body:
      level === 100
        ? `You have used all of your included AI usage for ${label}. It resumes when the window resets.`
        : `You have used over ${WARN_PCT}% of your included AI usage for ${label}.`,
  };
}

/**
 * Which alerts are due, given a reading and what has already been delivered.
 *
 * Pure, so the awkward cases are testable: crossing both thresholds between two
 * checks, a restart inside a window, a window that has rolled over, and the
 * proxy refusing at a percentage that still looks fine.
 */
export function decideUsageAlerts(
  meter: HostedUsageMeter | null,
  delivered: (key: string) => boolean,
): UsageAlert[] {
  // No reading and no plan both mean there is no window to warn about. A failed
  // read must never be treated as 0% (silent) OR as exhausted (a false alarm) —
  // it produces nothing, and the next check tries again.
  if (!meter || !meter.entitled) return [];

  const out: UsageAlert[] = [];
  // Tracks whether a window is FULL, not whether anything was queued: a 75%
  // alert firing in the same pass must not suppress the block notice, or the
  // user is told "running low" while nothing works at all.
  let exhausted = false;
  const consider = (window: UsageWindow, pct: number | null, resetsAt: string) => {
    if (pct === null) return; // unreadable window: no signal either way
    // 100 FIRST, and it suppresses the 75 for the same window: a user who goes
    // from 40% to full between two checks gets one notification, not two.
    if (pct >= 100) {
      exhausted = true;
      const full = alertFor(window, 100, resetsAt);
      if (!delivered(full.key)) out.push(full);
      return;
    }
    if (pct >= WARN_PCT) {
      const warn = alertFor(window, WARN_PCT, resetsAt);
      if (!delivered(warn.key)) out.push(warn);
    }
  };

  consider('session', meter.sessionPct, meter.sessionResetsAt);
  consider('week', meter.weekPct, meter.weekResetsAt);

  // `blocked` does NOT mean "the proxy refused you for spending too much".
  //
  // It is LiteLLM's explicit key-block flag, and the control plane writes it in
  // exactly two situations (hosting-llm packages/db/src/llm-sweeps.ts:380,488):
  // the user has no plan, and a converge that failed part-way left the key
  // blocked fail-closed. The first is already gone — !entitled returned above —
  // so reaching here means a user WITH a plan whose key is switched off. Their
  // assistant does not work and it is not their doing, which is worth an
  // interruption; calling it "used up" would be a lie that sends them to a
  // meter reading 4%.
  //
  // Budget exhaustion is caught by the percentages instead: sessionPct is
  // spend÷max_budget on the very key the proxy enforces, so >=100 IS the
  // refusal condition for the 6-hour window. The WEEK has no such guarantee —
  // the proxy enforces a rolling 7 days from key creation while we report a
  // Monday-aligned week, and nothing reads the proxy's own weekly counter, so a
  // refusal on it is invisible here. That gap is docs/LLM.md POC item 1 and
  // needs a live probe to close, not a guess from this side.
  if (meter.blocked && !exhausted) {
    const blocked: UsageAlert = {
      window: 'session',
      level: 100,
      key: `${FLAG_PREFIX}blocked.${meter.sessionResetsAt}`,
      title: 'AI is temporarily unavailable',
      body: 'Your assistant cannot reach its AI models right now. This is being fixed on our side — nothing you need to do.',
    };
    if (!delivered(blocked.key)) out.push(blocked);
  }
  return out;
}

/** Pluggable persistence so the decision is unit-testable without SQLite. */
export interface UsageAlertStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  /** Every delivered-flag key currently stored, for pruning. */
  keys(): string[];
  delete(key: string): void;
}

/**
 * Keys are only ever added, so without this a long-lived install accumulates
 * one row per window forever. A key is stale once neither live reset stamp
 * appears in it — that is the same self-expiry the key format already encodes,
 * just collected.
 */
export function staleFlagKeys(all: string[], meter: HostedUsageMeter): string[] {
  const live = [meter.sessionResetsAt, meter.weekResetsAt];
  return all.filter((k) => k.startsWith(FLAG_PREFIX) && !live.some((stamp) => k.endsWith(stamp)));
}

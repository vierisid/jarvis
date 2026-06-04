/**
 * Monthly spend guard for premium realtime voice (gpt-realtime-2).
 *
 * `voice.realtime.monthly_budget_usd` is a soft cost ceiling: once the running
 * monthly estimate reaches it, new realtime sessions are refused (the user is
 * told, and the standard pipeline is unaffected). OpenAI bills per token, but
 * we don't see a live invoice mid-session, so spend is ESTIMATED from session
 * wall-clock at the same ~$/min figure shown in Settings > Voice. This is an
 * approximate guard, not an accounting system — it errs toward stopping a
 * runaway session rather than billing precision. State persists to a small JSON
 * file so the cap survives daemon restarts and resets at each month boundary.
 *
 * See docs/GPT_REALTIME_2_INTEGRATION.md §4 Phase 3.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** Approximate blended $/min for gpt-realtime-2 (matches the Voice settings hint). */
export const ESTIMATED_USD_PER_MINUTE = 0.30;

export type BudgetState = { month: string; spentUsd: number };

/** UTC `YYYY-MM` bucket key for a given instant. */
export function monthKey(now: Date): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/** Estimate the USD cost of a session given its duration in seconds. */
export function estimateSessionCostUsd(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return (seconds / 60) * ESTIMATED_USD_PER_MINUTE;
}

/**
 * Pure: would this much spend be at/over the budget? A non-positive or
 * undefined budget means "no cap" and never blocks.
 */
export function isOverBudget(spentUsd: number, budgetUsd: number | undefined): boolean {
  if (budgetUsd === undefined || budgetUsd <= 0) return false;
  return spentUsd >= budgetUsd;
}

/** Pluggable persistence so the tracker is unit-testable without disk. */
export interface BudgetStore {
  load(): BudgetState | null;
  save(state: BudgetState): void;
}

class FileBudgetStore implements BudgetStore {
  constructor(private filePath: string) {}
  load(): BudgetState | null {
    try {
      if (!existsSync(this.filePath)) return null;
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8'));
      if (parsed && typeof parsed.month === 'string' && typeof parsed.spentUsd === 'number') {
        return parsed as BudgetState;
      }
    } catch { /* corrupt/unreadable -> treat as empty */ }
    return null;
  }
  save(state: BudgetState): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, JSON.stringify(state), 'utf8');
    } catch (err) {
      console.warn('[RealtimeBudget] failed to persist spend:', err);
    }
  }
}

export class RealtimeBudgetTracker {
  constructor(private store: BudgetStore) {}

  static fromFile(filePath: string): RealtimeBudgetTracker {
    return new RealtimeBudgetTracker(new FileBudgetStore(filePath));
  }

  /** Spend recorded for the current month (0 once the month rolls over). */
  getMonthSpend(now: Date = new Date()): number {
    const state = this.store.load();
    if (!state || state.month !== monthKey(now)) return 0;
    return state.spentUsd;
  }

  /** True if a new session may start under the given budget. */
  canStart(budgetUsd: number | undefined, now: Date = new Date()): boolean {
    return !isOverBudget(this.getMonthSpend(now), budgetUsd);
  }

  /** Add an estimated session cost (from its duration) to the monthly total. */
  recordSessionSeconds(seconds: number, now: Date = new Date()): void {
    const cost = estimateSessionCostUsd(seconds);
    if (cost <= 0) return;
    const key = monthKey(now);
    const prev = this.store.load();
    const base = prev && prev.month === key ? prev.spentUsd : 0;
    this.store.save({ month: key, spentUsd: base + cost });
  }
}

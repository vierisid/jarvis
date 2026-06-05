import { test, expect, describe, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RealtimeBudgetTracker,
  estimateSessionCostUsd,
  isOverBudget,
  monthKey,
  ESTIMATED_USD_PER_MINUTE,
  type BudgetState,
  type BudgetStore,
} from './realtime-budget.ts';

/** In-memory store so tracker logic is tested without touching disk. */
function memStore(initial: BudgetState | null = null): BudgetStore & { state: BudgetState | null } {
  return {
    state: initial,
    load() { return this.state; },
    save(s) { this.state = s; },
  };
}

describe('pure helpers', () => {
  test('monthKey is UTC YYYY-MM', () => {
    expect(monthKey(new Date('2026-06-04T12:00:00Z'))).toBe('2026-06');
    expect(monthKey(new Date('2026-01-01T00:00:00Z'))).toBe('2026-01');
    expect(monthKey(new Date('2026-12-31T23:59:59Z'))).toBe('2026-12');
  });

  test('estimateSessionCostUsd scales with minutes', () => {
    expect(estimateSessionCostUsd(60)).toBeCloseTo(ESTIMATED_USD_PER_MINUTE, 6);
    expect(estimateSessionCostUsd(120)).toBeCloseTo(ESTIMATED_USD_PER_MINUTE * 2, 6);
    expect(estimateSessionCostUsd(0)).toBe(0);
    expect(estimateSessionCostUsd(-5)).toBe(0);
    expect(estimateSessionCostUsd(NaN)).toBe(0);
  });

  test('isOverBudget treats unset/non-positive budget as no cap', () => {
    expect(isOverBudget(1000, undefined)).toBe(false);
    expect(isOverBudget(1000, 0)).toBe(false);
    expect(isOverBudget(1000, -5)).toBe(false);
    expect(isOverBudget(4.99, 5)).toBe(false);
    expect(isOverBudget(5, 5)).toBe(true);
    expect(isOverBudget(5.01, 5)).toBe(true);
  });
});

describe('RealtimeBudgetTracker', () => {
  const NOW = new Date('2026-06-04T12:00:00Z');

  test('records and accumulates spend within a month', () => {
    const store = memStore();
    const t = new RealtimeBudgetTracker(store);
    t.recordSessionSeconds(60, NOW);   // +$0.30
    t.recordSessionSeconds(120, NOW);  // +$0.60
    expect(t.getMonthSpend(NOW)).toBeCloseTo(0.90, 6);
    expect(store.state?.month).toBe('2026-06');
  });

  test('spend resets when the month rolls over', () => {
    const store = memStore({ month: '2026-05', spentUsd: 99 });
    const t = new RealtimeBudgetTracker(store);
    // Reading in June ignores May's total.
    expect(t.getMonthSpend(NOW)).toBe(0);
    // Recording in June starts fresh, not 99 + cost.
    t.recordSessionSeconds(60, NOW);
    expect(t.getMonthSpend(NOW)).toBeCloseTo(0.30, 6);
  });

  test('canStart blocks once spend reaches the budget', () => {
    const store = memStore();
    const t = new RealtimeBudgetTracker(store);
    expect(t.canStart(1, NOW)).toBe(true);
    // ~3.4 min of session puts us over a $1 cap.
    t.recordSessionSeconds(60 * 4, NOW);
    expect(t.canStart(1, NOW)).toBe(false);
    // No cap -> always allowed.
    expect(t.canStart(undefined, NOW)).toBe(true);
  });
});

describe('RealtimeBudgetTracker file persistence', () => {
  const NOW = new Date('2026-06-04T12:00:00Z');
  const dirs: string[] = [];
  function tmpFile(): string {
    const dir = mkdtempSync(join(tmpdir(), 'jarvis-budget-'));
    dirs.push(dir);
    return join(dir, 'nested', 'realtime-budget.json');
  }
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  test('persists across tracker instances (survives restart) and creates the dir', () => {
    const path = tmpFile();
    RealtimeBudgetTracker.fromFile(path).recordSessionSeconds(120, NOW); // $0.60
    // A fresh tracker reading the same file sees the prior spend.
    expect(RealtimeBudgetTracker.fromFile(path).getMonthSpend(NOW)).toBeCloseTo(0.60, 6);
    // And the persisted shape is what we expect.
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ month: '2026-06', spentUsd: 0.60 });
  });

  test('missing file reads as zero spend', () => {
    expect(RealtimeBudgetTracker.fromFile(tmpFile()).getMonthSpend(NOW)).toBe(0);
  });

  test('corrupt or malformed JSON is treated as empty, not a crash', () => {
    const path = tmpFile();
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, '{ not valid json', 'utf8');
    const t = RealtimeBudgetTracker.fromFile(path);
    expect(t.getMonthSpend(NOW)).toBe(0);
    // Recovers by overwriting with a valid state on the next record.
    t.recordSessionSeconds(60, NOW);
    expect(t.getMonthSpend(NOW)).toBeCloseTo(0.30, 6);

    // Wrong-typed fields are also rejected.
    writeFileSync(path, JSON.stringify({ month: 5, spentUsd: 'lots' }), 'utf8');
    expect(RealtimeBudgetTracker.fromFile(path).getMonthSpend(NOW)).toBe(0);
  });
});

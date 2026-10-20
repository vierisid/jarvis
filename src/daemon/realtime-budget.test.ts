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
  estimateTranscriptionCostUsd,
  recordTranscriptionSpend,
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

// #1007 turned on input transcription, billed apart from the session minutes.
describe('input transcription spend', () => {
  test('token usage is costed at the published gpt-4o-mini-transcribe rates', () => {
    // $1.25 / 1M input, $5 / 1M output.
    expect(estimateTranscriptionCostUsd({ input_tokens: 1_000_000, output_tokens: 0 })).toBeCloseTo(1.25, 10);
    expect(estimateTranscriptionCostUsd({ input_tokens: 0, output_tokens: 1_000_000 })).toBeCloseTo(5, 10);
    expect(estimateTranscriptionCostUsd({ input_tokens: 400, output_tokens: 20 })).toBeCloseTo(400 * 1.25e-6 + 20 * 5e-6, 12);
  });

  test('duration usage (Whisper only) is costed at Whisper\'s published $0.006 per minute', () => {
    expect(estimateTranscriptionCostUsd({ input_tokens: 0, output_tokens: 0, seconds: 120 })).toBeCloseTo(0.012, 10);
    expect(estimateTranscriptionCostUsd({ input_tokens: 0, output_tokens: 0, seconds: 0 })).toBe(0);
  });

  test('a BYO session charges it to the monthly budget, on top of the minutes', () => {
    const store = memStore();
    const tracker = new RealtimeBudgetTracker(store);
    const now = new Date('2026-10-20T12:00:00Z');
    tracker.recordSessionSeconds(60, now);
    recordTranscriptionSpend(() => tracker, 'openai', 0.01, now);
    expect(tracker.getMonthSpend(now)).toBeCloseTo(ESTIMATED_USD_PER_MINUTE + 0.01, 10);
  });

  test('a hosted session does not: the proxy bills it', () => {
    const store = memStore();
    const tracker = new RealtimeBudgetTracker(store);
    recordTranscriptionSpend(() => tracker, 'usejarvis_ai', 0.01);
    expect(store.state).toBeNull();
  });

  test('it can tip a BYO budget over the cap', () => {
    const tracker = new RealtimeBudgetTracker(memStore());
    const now = new Date('2026-10-20T12:00:00Z');
    tracker.recordSessionSeconds(60 * 10, now); // $3.00 of minutes
    expect(tracker.canStart(3.005, now)).toBe(true);
    recordTranscriptionSpend(() => tracker, 'openai', estimateTranscriptionCostUsd({ input_tokens: 0, output_tokens: 0, seconds: 120 }), now);
    expect(tracker.canStart(3.005, now)).toBe(false);
  });
});

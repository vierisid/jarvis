import { describe, expect, it, beforeEach } from 'bun:test';
import { initDatabase, closeDb } from '../vault/schema.ts';
import {
  setUsageDatabase,
  recordUsage,
  queryUsage,
  listUsageDistinctValues,
} from './usage.ts';
import type { Tier } from './tiers.ts';

function seed() {
  const samples: Array<{
    msAgo: number;
    tier: Tier;
    model: string;
    subsystem: string;
    provider: string;
    in: number;
    out: number;
    latency: number;
    err?: string;
  }> = [
    { msAgo: 0,           tier: 'conversation', model: 'gpt-4o-mini',  subsystem: 'conv_orchestrator',   provider: 'openai',    in: 100, out: 50,  latency: 800 },
    { msAgo: 60_000,      tier: 'medium',       model: 'claude-sonnet',subsystem: 'chat_orchestrator',   provider: 'anthropic', in: 500, out: 200, latency: 2400 },
    { msAgo: 120_000,     tier: 'low',          model: 'llama3',       subsystem: 'voice_intent',        provider: 'ollama',    in: 200, out: 80,  latency: 5000 },
    { msAgo: 180_000,     tier: 'low',          model: 'llama3',       subsystem: 'vault_extractor',     provider: 'ollama',    in: 250, out: 100, latency: 4800 },
    { msAgo: 240_000,     tier: 'conversation', model: 'gpt-4o-mini',  subsystem: 'conv_orchestrator',   provider: 'openai',    in: 110, out: 55,  latency: 700, err: 'auth' },
    { msAgo: 8 * 86400000,tier: 'medium',       model: 'claude-sonnet',subsystem: 'task_research',       provider: 'anthropic', in: 800, out: 300, latency: 3500 }, // > 7 days ago
  ];
  for (const s of samples) {
    recordUsage({
      tier: s.tier,
      resolved_tier: s.tier,
      subsystem: s.subsystem,
      provider: s.provider,
      model: s.model,
      input_tokens: s.in,
      output_tokens: s.out,
      latency_ms: s.latency,
      error_code: s.err,
    });
  }
}

describe('queryUsage', () => {
  beforeEach(() => {
    closeDb();
    const db = initDatabase(':memory:');
    setUsageDatabase(() => db);
    seed();

    // Backdate rows so the timestamps span multiple periods.
    const now = Date.now();
    const offsets = [0, 60_000, 120_000, 180_000, 240_000, 8 * 86400000];
    for (let i = 0; i < offsets.length; i++) {
      db.run(`UPDATE llm_usage SET ts = ? WHERE id = ?`, [now - offsets[i]!, i + 1]);
    }
  });

  it('totals include all rows in the default 30-day window', () => {
    const r = queryUsage({}, 'model');
    expect(r.total.calls).toBe(6);
    expect(r.total.input_tokens).toBe(100 + 500 + 200 + 250 + 110 + 800);
    expect(r.total.errors).toBe(1);
  });

  it('filters by tier', () => {
    const r = queryUsage({ tiers: ['conversation'] }, 'model');
    expect(r.total.calls).toBe(2);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.key).toBe('gpt-4o-mini');
    expect(r.rows[0]!.calls).toBe(2);
  });

  it('filters by subsystem', () => {
    const r = queryUsage({ subsystems: ['voice_intent', 'vault_extractor'] }, 'subsystem');
    expect(r.total.calls).toBe(2);
    expect(r.rows.map((x) => x.key).sort()).toEqual(['vault_extractor', 'voice_intent']);
  });

  it('filters by date range', () => {
    const now = Date.now();
    // 7-day window excludes the 8-day-old row.
    const r = queryUsage({ fromMs: now - 7 * 86400000, toMs: now });
    expect(r.total.calls).toBe(5);
  });

  it('group by date returns one row per day', () => {
    const r = queryUsage({}, 'date');
    // Rows from today and 8 days ago should produce 2 distinct date buckets.
    expect(r.rows.length).toBeGreaterThanOrEqual(2);
  });

  it('errors_only=true returns only failures', () => {
    const r = queryUsage({ errorsOnly: true }, 'model');
    expect(r.total.calls).toBe(1);
    expect(r.total.errors).toBe(1);
  });

  it('group by none returns raw rows', () => {
    const r = queryUsage({ tiers: ['low'] }, 'none');
    expect(r.rows).toEqual([]);
    expect(r.raw).toBeDefined();
    expect(r.raw!.length).toBe(2);
    // Newest first
    expect(r.raw![0]!.ts).toBeGreaterThan(r.raw![1]!.ts);
  });

  it('listUsageDistinctValues returns sorted unique values', () => {
    const distinct = listUsageDistinctValues();
    expect(distinct.tiers).toEqual(['conversation', 'low', 'medium']);
    expect(distinct.models).toContain('claude-sonnet');
    expect(distinct.models).toContain('gpt-4o-mini');
    expect(distinct.subsystems).toContain('voice_intent');
    expect(distinct.providers.sort()).toEqual(['anthropic', 'ollama', 'openai']);
    expect(distinct.earliest_ts).toBeDefined();
    expect(distinct.latest_ts).toBeDefined();
  });

  it('returns empty result when DB has no rows', () => {
    closeDb();
    const db = initDatabase(':memory:');
    setUsageDatabase(() => db);
    const r = queryUsage({}, 'model');
    expect(r.total.calls).toBe(0);
    expect(r.rows).toEqual([]);
  });
});

describe('recordUsage resilience', () => {
  it('swallows a throwing resolver (mirrors production "() => getDb()" with no DB initialized)', () => {
    // The production wiring uses `() => getDb()` which throws when the DB
    // isn't initialized. recordUsage MUST stay best-effort and not propagate
    // - otherwise every chatTier/streamTier call in a test that didn't init
    // the DB would crash. Regression for the CI failure we hit on the first
    // pass of realtime usage tracking.
    closeDb();
    setUsageDatabase(() => { throw new Error('Database not initialized'); });

    // Silence the expected "[LLMUsage] Failed to record usage" warning; the
    // assertion below proves the swallow path fired, not the log line.
    const origWarn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => warnings.push(args);
    try {
      expect(() => recordUsage({
        tier: 'low',
        resolved_tier: 'low',
        subsystem: 'test',
        provider: 'stub',
        model: 'stub',
        input_tokens: 1,
        output_tokens: 1,
        latency_ms: 1,
      })).not.toThrow();
    } finally {
      console.warn = origWarn;
      // Reset to a no-op so the resolver doesn't leak into other test files.
      setUsageDatabase(() => null);
    }
    expect(warnings.length).toBe(1);
    expect(String(warnings[0]![0])).toContain('Failed to record usage');
  });
});

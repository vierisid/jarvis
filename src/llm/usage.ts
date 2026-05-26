/**
 * LLM usage tracking - persistent per-call accounting of which subsystem made
 * which call, on which tier, against which model.
 *
 * No caps, no budget enforcement here. Just records what happened so the
 * future cost dashboard and the optimization work in later phases have ground
 * truth to compare against.
 *
 * Subsystem labels are required at every call site (no anonymous calls) so
 * we can attribute consumption to chat / heartbeat / voice-intent / extractor
 * / suggestion-engine / etc.
 */

import type { Database } from 'bun:sqlite';
import type { Tier } from './tiers.ts';

type DbResolver = () => Database | null;

export type UsageRecord = {
  tier: Tier;
  resolved_tier: Tier;       // tier that actually answered (may differ if fell up)
  subsystem: string;          // caller label: chat, heartbeat, voice_intent, extractor, ...
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
  error_code?: string;        // only populated on failure
};

export type DailyUsageRow = {
  date: string;               // YYYY-MM-DD
  tier: Tier;
  subsystem: string;
  provider: string;
  model: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  total_latency_ms: number;
  errors: number;
};

let resolveDb: DbResolver = () => null;

/**
 * Wire the usage tracker to the live DB. Pass a resolver function (not the
 * Database instance) so that re-opens / test resets are picked up automatically
 * without leaving a stale handle behind.
 */
export function setUsageDatabase(resolver: DbResolver | Database): void {
  resolveDb = typeof resolver === 'function' ? resolver : () => resolver;
}

export function recordUsage(rec: UsageRecord): void {
  const db = resolveDb();
  if (!db) return;          // tracking is best-effort - never break the call
  try {
    const ts = Date.now();
    db.run(
      `INSERT INTO llm_usage (
        ts, tier, resolved_tier, subsystem, provider, model,
        input_tokens, output_tokens, latency_ms, error_code
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        ts,
        rec.tier,
        rec.resolved_tier,
        rec.subsystem,
        rec.provider,
        rec.model,
        rec.input_tokens,
        rec.output_tokens,
        rec.latency_ms,
        rec.error_code ?? null,
      ],
    );
  } catch (err) {
    console.warn('[LLMUsage] Failed to record usage:', err);
  }
}

/**
 * Return per-day aggregates grouped by tier, subsystem, provider, model.
 * `daysBack` defaults to 7.
 */
export function getDailyRollup(daysBack: number = 7): DailyUsageRow[] {
  const db = resolveDb();
  if (!db) return [];
  const sinceMs = Date.now() - daysBack * 24 * 60 * 60 * 1000;
  try {
    const rows = db
      .query<DailyUsageRow, [number]>(
        `SELECT
          date(ts/1000, 'unixepoch', 'localtime') as date,
          tier,
          subsystem,
          provider,
          model,
          COUNT(*) as calls,
          SUM(input_tokens) as input_tokens,
          SUM(output_tokens) as output_tokens,
          SUM(latency_ms) as total_latency_ms,
          SUM(CASE WHEN error_code IS NOT NULL THEN 1 ELSE 0 END) as errors
        FROM llm_usage
        WHERE ts >= ?
        GROUP BY date, tier, subsystem, provider, model
        ORDER BY date DESC, tier, subsystem`,
      )
      .all(sinceMs);
    return rows;
  } catch (err) {
    console.warn('[LLMUsage] Failed to compute rollup:', err);
    return [];
  }
}

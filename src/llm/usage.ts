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
  // Tracking is best-effort: a misbehaving resolver (e.g. the production
  // wiring is `() => getDb()`, which throws when the DB isn't initialized
  // during a test that never called initDatabase) MUST NOT propagate out of
  // here and break the calling chatTier/streamTier path. Catch around the
  // resolver call AND the DB write.
  try {
    const db = resolveDb();
    if (!db) return;
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
 * `daysBack` defaults to 7. Kept for the older /api/usage-daily endpoint.
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

// ── Flexible query API for the dashboard ─────────────────────────────────

export type UsageQueryFilters = {
  /** Inclusive lower bound, unix-ms. Defaults to 30 days ago. */
  fromMs?: number;
  /** Inclusive upper bound, unix-ms. Defaults to now. */
  toMs?: number;
  /** Match if `tier` is in this list. Filter dropped when empty/undefined. */
  tiers?: string[];
  models?: string[];
  subsystems?: string[];
  providers?: string[];
  /** Match if error_code is non-null (true) or null (false). Undefined = both. */
  errorsOnly?: boolean;
};

/**
 * What axis to aggregate by. "none" returns raw rows (capped) for inspection.
 */
export type UsageGroupBy = 'tier' | 'model' | 'subsystem' | 'provider' | 'date' | 'none';

export type UsageQueryRow = {
  key: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  total_latency_ms: number;
  errors: number;
};

export type UsageQueryTotals = {
  calls: number;
  input_tokens: number;
  output_tokens: number;
  total_latency_ms: number;
  errors: number;
};

export type UsageRawRow = {
  ts: number;
  tier: string;
  resolved_tier: string;
  subsystem: string;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
  error_code: string | null;
};

export type UsageQueryResult = {
  rows: UsageQueryRow[];
  total: UsageQueryTotals;
  /** Only populated when groupBy === 'none'. Truncated to keep payloads small. */
  raw?: UsageRawRow[];
  raw_truncated?: boolean;
};

const RAW_ROW_LIMIT = 500;

/**
 * Run a filtered + grouped query over llm_usage.
 *
 *   queryUsage({ fromMs, toMs, tiers: ['conversation'] }, 'model')
 *
 * `groupBy='none'` returns up to RAW_ROW_LIMIT raw rows (newest first) plus
 * the totals. Any other groupBy returns one row per group key.
 */
export function queryUsage(
  filters: UsageQueryFilters,
  groupBy: UsageGroupBy = 'model',
): UsageQueryResult {
  const db = resolveDb();
  const empty: UsageQueryResult = {
    rows: [],
    total: { calls: 0, input_tokens: 0, output_tokens: 0, total_latency_ms: 0, errors: 0 },
  };
  if (!db) return empty;

  const now = Date.now();
  const fromMs = filters.fromMs ?? now - 30 * 24 * 60 * 60 * 1000;
  const toMs = filters.toMs ?? now;

  const where: string[] = ['ts >= ?', 'ts <= ?'];
  const params: (string | number)[] = [fromMs, toMs];

  const addInClause = (column: string, values: string[] | undefined) => {
    if (!values || values.length === 0) return;
    where.push(`${column} IN (${values.map(() => '?').join(',')})`);
    params.push(...values);
  };

  addInClause('tier', filters.tiers);
  addInClause('model', filters.models);
  addInClause('subsystem', filters.subsystems);
  addInClause('provider', filters.providers);

  if (filters.errorsOnly === true) where.push('error_code IS NOT NULL');
  if (filters.errorsOnly === false) where.push('error_code IS NULL');

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  // Totals always come from the same WHERE.
  try {
    const totalRow = db
      .query<UsageQueryTotals, (string | number)[]>(
        `SELECT
          COUNT(*) as calls,
          COALESCE(SUM(input_tokens), 0) as input_tokens,
          COALESCE(SUM(output_tokens), 0) as output_tokens,
          COALESCE(SUM(latency_ms), 0) as total_latency_ms,
          SUM(CASE WHEN error_code IS NOT NULL THEN 1 ELSE 0 END) as errors
        FROM llm_usage
        ${whereSql}`,
      )
      .get(...params) ?? empty.total;

    if (groupBy === 'none') {
      const rawRows = db
        .query<UsageRawRow, (string | number)[]>(
          `SELECT ts, tier, resolved_tier, subsystem, provider, model,
                  input_tokens, output_tokens, latency_ms, error_code
           FROM llm_usage
           ${whereSql}
           ORDER BY ts DESC
           LIMIT ${RAW_ROW_LIMIT + 1}`,
        )
        .all(...params);
      const truncated = rawRows.length > RAW_ROW_LIMIT;
      return {
        rows: [],
        total: totalRow,
        raw: truncated ? rawRows.slice(0, RAW_ROW_LIMIT) : rawRows,
        raw_truncated: truncated,
      };
    }

    // Defense in depth: keyColumn is string-interpolated into the SQL below.
    // TypeScript enforces the UsageGroupBy union at compile time, but we
    // still gate at runtime to prevent any untrusted caller from sneaking in
    // an arbitrary column expression.
    const ALLOWED_GROUP_COLUMNS: Record<Exclude<UsageGroupBy, 'date' | 'none'>, string> = {
      tier: 'tier',
      model: 'model',
      subsystem: 'subsystem',
      provider: 'provider',
    };
    const keyColumn = groupBy === 'date'
      ? `date(ts/1000, 'unixepoch', 'localtime')`
      : ALLOWED_GROUP_COLUMNS[groupBy];
    if (!keyColumn) {
      // Should be unreachable given the typed union and the 'none' branch
      // above, but stay defensive.
      console.warn(`[LLMUsage] queryUsage: unknown groupBy '${groupBy}'`);
      return empty;
    }

    const rows = db
      .query<UsageQueryRow, (string | number)[]>(
        `SELECT
          ${keyColumn} as key,
          COUNT(*) as calls,
          COALESCE(SUM(input_tokens), 0) as input_tokens,
          COALESCE(SUM(output_tokens), 0) as output_tokens,
          COALESCE(SUM(latency_ms), 0) as total_latency_ms,
          SUM(CASE WHEN error_code IS NOT NULL THEN 1 ELSE 0 END) as errors
        FROM llm_usage
        ${whereSql}
        GROUP BY ${keyColumn}
        ORDER BY ${groupBy === 'date' ? 'key DESC' : 'calls DESC'}`,
      )
      .all(...params);

    return { rows, total: totalRow };
  } catch (err) {
    console.warn('[LLMUsage] queryUsage failed:', err);
    return empty;
  }
}

/**
 * Return distinct values present in the DB for each filterable column,
 * plus the earliest/latest timestamps. Used by the UI to populate filter
 * dropdowns with only the values that actually exist (no empty choices).
 */
export function listUsageDistinctValues(): {
  tiers: string[];
  models: string[];
  subsystems: string[];
  providers: string[];
  earliest_ts: number | null;
  latest_ts: number | null;
} {
  const db = resolveDb();
  const empty = {
    tiers: [],
    models: [],
    subsystems: [],
    providers: [],
    earliest_ts: null as number | null,
    latest_ts: null as number | null,
  };
  if (!db) return empty;
  try {
    const distinct = (column: string): string[] => {
      const rows = db
        .query<{ v: string }, []>(`SELECT DISTINCT ${column} as v FROM llm_usage WHERE ${column} IS NOT NULL ORDER BY v`)
        .all();
      return rows.map((r) => r.v).filter((v): v is string => typeof v === 'string' && v.length > 0);
    };
    const range = db
      .query<{ earliest: number | null; latest: number | null }, []>(
        `SELECT MIN(ts) as earliest, MAX(ts) as latest FROM llm_usage`,
      )
      .get();
    return {
      tiers: distinct('tier'),
      models: distinct('model'),
      subsystems: distinct('subsystem'),
      providers: distinct('provider'),
      earliest_ts: range?.earliest ?? null,
      latest_ts: range?.latest ?? null,
    };
  } catch (err) {
    console.warn('[LLMUsage] listUsageDistinctValues failed:', err);
    return empty;
  }
}

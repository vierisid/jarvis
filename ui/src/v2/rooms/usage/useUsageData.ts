import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type UsageTier = "conversation" | "high" | "medium" | "low";

export type UsageGroupBy = "tier" | "model" | "subsystem" | "provider" | "date" | "none";

export type UsagePeriod = "today" | "7d" | "30d" | "this_month" | "last_month" | "custom";

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
  raw?: UsageRawRow[];
  raw_truncated?: boolean;
};

export type UsageFilterOptions = {
  tiers: string[];
  models: string[];
  subsystems: string[];
  providers: string[];
  earliest_ts: number | null;
  latest_ts: number | null;
};

export type UsageFilters = {
  period: UsagePeriod;
  customFrom: string | null;        // YYYY-MM-DD
  customTo: string | null;
  tiers: string[];
  models: string[];
  subsystems: string[];
  providers: string[];
  errorsOnly: boolean;
  groupBy: UsageGroupBy;
};

const DEFAULT_FILTERS: UsageFilters = {
  period: "30d",
  customFrom: null,
  customTo: null,
  tiers: [],
  models: [],
  subsystems: [],
  providers: [],
  errorsOnly: false,
  groupBy: "model",
};

/**
 * Convert the period preset + custom dates into a {fromMs, toMs} pair the
 * backend can filter on. Day boundaries are computed in the local timezone
 * so "today" matches what the user expects in their wall clock.
 */
function resolvePeriod(filters: UsageFilters): { fromMs: number; toMs: number } {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  switch (filters.period) {
    case "today":
      return { fromMs: startOfToday.getTime(), toMs: now.getTime() };
    case "7d":
      return { fromMs: now.getTime() - 7 * 86400000, toMs: now.getTime() };
    case "30d":
      return { fromMs: now.getTime() - 30 * 86400000, toMs: now.getTime() };
    case "this_month": {
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      return { fromMs: start.getTime(), toMs: now.getTime() };
    }
    case "last_month": {
      const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const end = new Date(now.getFullYear(), now.getMonth(), 1);
      return { fromMs: start.getTime(), toMs: end.getTime() };
    }
    case "custom": {
      const from = filters.customFrom ? new Date(`${filters.customFrom}T00:00:00`).getTime() : now.getTime() - 30 * 86400000;
      const to = filters.customTo ? new Date(`${filters.customTo}T23:59:59.999`).getTime() : now.getTime();
      return { fromMs: from, toMs: to };
    }
  }
}

/**
 * Fetch usage data + filter options for the Usage room.
 *
 * The hook tracks filter state internally; consumers call `setFilter` with
 * partial updates and the hook refetches automatically. Distinct values are
 * fetched once on mount and on manual refresh.
 */
export function useUsageData() {
  const [filters, setFilters] = useState<UsageFilters>(DEFAULT_FILTERS);
  const [result, setResult] = useState<UsageQueryResult | null>(null);
  const [options, setOptions] = useState<UsageFilterOptions | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlightRef = useRef(0);

  const setFilter = useCallback(<K extends keyof UsageFilters>(key: K, value: UsageFilters[K]) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
  }, []);

  const toggleListFilter = useCallback(
    (key: "tiers" | "models" | "subsystems" | "providers", value: string) => {
      setFilters((prev) => {
        const set = new Set(prev[key]);
        if (set.has(value)) set.delete(value);
        else set.add(value);
        return { ...prev, [key]: Array.from(set) };
      });
    },
    [],
  );

  const clearFilters = useCallback(() => {
    setFilters((prev) => ({
      ...DEFAULT_FILTERS,
      period: prev.period,
      customFrom: prev.customFrom,
      customTo: prev.customTo,
    }));
  }, []);

  const fetchOptions = useCallback(async () => {
    try {
      const r = await fetch("/api/usage/filters");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setOptions((await r.json()) as UsageFilterOptions);
    } catch (err) {
      console.warn("[useUsageData] filter options fetch failed:", err);
    }
  }, []);

  const fetchUsage = useCallback(async () => {
    const { fromMs, toMs } = resolvePeriod(filters);
    const params = new URLSearchParams();
    params.set("from", String(fromMs));
    params.set("to", String(toMs));
    if (filters.tiers.length) params.set("tier", filters.tiers.join(","));
    if (filters.models.length) params.set("model", filters.models.join(","));
    if (filters.subsystems.length) params.set("subsystem", filters.subsystems.join(","));
    if (filters.providers.length) params.set("provider", filters.providers.join(","));
    if (filters.errorsOnly) params.set("errors_only", "true");
    params.set("group_by", filters.groupBy);

    const reqId = ++inFlightRef.current;
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`/api/usage?${params.toString()}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as UsageQueryResult;
      if (reqId === inFlightRef.current) setResult(data);
    } catch (err) {
      if (reqId === inFlightRef.current) {
        setError(err instanceof Error ? err.message : "Failed to load usage data");
      }
    } finally {
      if (reqId === inFlightRef.current) setLoading(false);
    }
  }, [filters]);

  useEffect(() => { fetchOptions(); }, [fetchOptions]);
  useEffect(() => { fetchUsage(); }, [fetchUsage]);

  const refresh = useCallback(() => {
    fetchOptions();
    fetchUsage();
  }, [fetchOptions, fetchUsage]);

  const period = useMemo(() => resolvePeriod(filters), [filters]);

  return {
    filters,
    setFilter,
    toggleListFilter,
    clearFilters,
    result,
    options,
    loading,
    error,
    refresh,
    period,
  };
}

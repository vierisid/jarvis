import React, { useMemo } from "react";
import { Activity, AlertCircle, BarChart3, Calendar, Filter, RefreshCw, X, type LucideIcon } from "lucide-react";
import { Icon } from "../../ui";
import { RoomShell } from "../RoomShell";
import { MultiSelectDropdown } from "./MultiSelectDropdown";
import {
  useUsageData,
  type UsageFilters,
  type UsageGroupBy,
  type UsagePeriod,
  type UsageRawRow,
} from "./useUsageData";
import "./UsageRoom.css";

const PERIOD_LABELS: Record<UsagePeriod, string> = {
  today: "Today",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  this_month: "This month",
  last_month: "Last month",
  custom: "Custom",
};

const GROUP_BY_LABELS: Record<UsageGroupBy, string> = {
  model: "Model",
  tier: "Difficulty (tier)",
  subsystem: "Task (subsystem)",
  provider: "Provider",
  date: "Date",
  none: "Raw rows",
};

const TIER_LABELS: Record<string, string> = {
  conversation: "Conversation",
  high: "High",
  medium: "Medium",
  low: "Low",
};

export type RoomBodyMode = "inline" | "expanded";

export function UsageRoom() {
  return (
    <RoomShell title="Usage" subtitle="LLM token telemetry · filterable" breadcrumb={["Usage"]}>
      <UsageRoomBody mode="expanded" />
    </RoomShell>
  );
}

export function UsageRoomBody({ mode = "expanded" }: { mode?: RoomBodyMode } = {}) {
  void mode; // Same layout in both modes for now; reserved for future tweaks.
  const data = useUsageData();

  return (
    <div className="v2-usage">
      <FilterBar data={data} />
      <TotalsStrip totals={data.result?.total} loading={data.loading} />
      <div className="v2-usage__main">
        {data.error && (
          <div className="v2-usage__error">
            <Icon icon={AlertCircle} size="sm" /> {data.error}
          </div>
        )}
        {data.filters.groupBy === "none" ? (
          <RawRowsTable rows={data.result?.raw ?? []} truncated={data.result?.raw_truncated} loading={data.loading} />
        ) : (
          <GroupedTable
            rows={data.result?.rows ?? []}
            groupBy={data.filters.groupBy}
            loading={data.loading}
          />
        )}
      </div>
    </div>
  );
}

// ─── Filter bar ───────────────────────────────────────────────────────────

function FilterBar({ data }: { data: ReturnType<typeof useUsageData> }) {
  const { filters, options, setFilter, toggleListFilter, clearFilters, refresh, period } = data;

  const periodSummary = useMemo(() => {
    const fmt = (ms: number) => new Date(ms).toLocaleDateString();
    return `${fmt(period.fromMs)} → ${fmt(period.toMs)}`;
  }, [period.fromMs, period.toMs]);

  const anyFilter =
    filters.tiers.length > 0 ||
    filters.models.length > 0 ||
    filters.subsystems.length > 0 ||
    filters.providers.length > 0 ||
    filters.errorsOnly;

  return (
    <div className="v2-usage__filters">
      <div className="v2-usage__filter-row">
        <div className="v2-usage__filter-group">
          <label className="v2-usage__filter-label">
            <Icon icon={Calendar} size="sm" /> Period
          </label>
          <select
            className="v2-usage__select"
            value={filters.period}
            onChange={(e) => setFilter("period", e.target.value as UsagePeriod)}
          >
            {(Object.keys(PERIOD_LABELS) as UsagePeriod[]).map((p) => (
              <option key={p} value={p}>{PERIOD_LABELS[p]}</option>
            ))}
          </select>
          {filters.period === "custom" && (
            <>
              <input
                type="date"
                className="v2-usage__date"
                value={filters.customFrom ?? ""}
                onChange={(e) => setFilter("customFrom", e.target.value || null)}
              />
              <span className="v2-usage__dim">→</span>
              <input
                type="date"
                className="v2-usage__date"
                value={filters.customTo ?? ""}
                onChange={(e) => setFilter("customTo", e.target.value || null)}
              />
            </>
          )}
          <span className="v2-usage__period-summary" title="Resolved period">
            {periodSummary}
          </span>
        </div>

        <div className="v2-usage__filter-group">
          <label className="v2-usage__filter-label">
            <Icon icon={BarChart3} size="sm" /> Group by
          </label>
          <select
            className="v2-usage__select"
            value={filters.groupBy}
            onChange={(e) => setFilter("groupBy", e.target.value as UsageGroupBy)}
          >
            {(Object.keys(GROUP_BY_LABELS) as UsageGroupBy[]).map((g) => (
              <option key={g} value={g}>{GROUP_BY_LABELS[g]}</option>
            ))}
          </select>
        </div>

        <button
          type="button"
          className="v2-usage__btn"
          onClick={refresh}
          title="Refresh"
        >
          <Icon icon={RefreshCw} size="sm" /> Refresh
        </button>
      </div>

      <ChipFilterRow
        label="Difficulty"
        options={options?.tiers ?? []}
        selected={filters.tiers}
        onToggle={(v) => toggleListFilter("tiers", v)}
        renderLabel={(v) => TIER_LABELS[v] ?? v}
      />

      {/*
        Model / Task / Provider lists can grow large (20+ entries on a
        well-used daemon). Render them as dropdowns instead of chip rows so
        the filter bar stays scannable. Each dropdown self-hides when its
        option list is empty.
      */}
      <div className="v2-usage__filter-row">
        <MultiSelectDropdown
          label="Model"
          options={options?.models ?? []}
          selected={filters.models}
          onToggle={(v) => toggleListFilter("models", v)}
          onClear={() => setFilter("models", [])}
        />
        <MultiSelectDropdown
          label="Task"
          options={options?.subsystems ?? []}
          selected={filters.subsystems}
          onToggle={(v) => toggleListFilter("subsystems", v)}
          onClear={() => setFilter("subsystems", [])}
        />
        <MultiSelectDropdown
          label="Provider"
          options={options?.providers ?? []}
          selected={filters.providers}
          onToggle={(v) => toggleListFilter("providers", v)}
          onClear={() => setFilter("providers", [])}
        />
      </div>

      <div className="v2-usage__filter-row">
        <label className="v2-usage__check">
          <input
            type="checkbox"
            checked={filters.errorsOnly}
            onChange={(e) => setFilter("errorsOnly", e.target.checked)}
          />
          Errors only
        </label>
        {anyFilter && (
          <button
            type="button"
            className="v2-usage__btn v2-usage__btn--ghost"
            onClick={clearFilters}
          >
            <Icon icon={X} size="sm" /> Clear filters
          </button>
        )}
      </div>
    </div>
  );
}

function ChipFilterRow({
  label,
  options,
  selected,
  onToggle,
  renderLabel,
}: {
  label: string;
  options: string[];
  selected: string[];
  onToggle: (v: string) => void;
  renderLabel?: (v: string) => string;
}) {
  if (options.length === 0) return null;
  return (
    <div className="v2-usage__chip-row" role="group" aria-label={label}>
      <span className="v2-usage__chip-label">
        <Icon icon={Filter} size="sm" /> {label}
      </span>
      {options.map((v) => {
        const active = selected.includes(v);
        return (
          <button
            key={v}
            type="button"
            className="v2-usage__chip"
            data-active={active}
            onClick={() => onToggle(v)}
          >
            {renderLabel?.(v) ?? v}
          </button>
        );
      })}
    </div>
  );
}

// ─── Totals strip ─────────────────────────────────────────────────────────

function TotalsStrip({
  totals,
  loading,
}: {
  totals: { calls: number; input_tokens: number; output_tokens: number; total_latency_ms: number; errors: number } | undefined;
  loading: boolean;
}) {
  const calls = totals?.calls ?? 0;
  const input = totals?.input_tokens ?? 0;
  const output = totals?.output_tokens ?? 0;
  const total = input + output;
  const errors = totals?.errors ?? 0;
  const avgLatency = calls > 0 ? Math.round((totals?.total_latency_ms ?? 0) / calls) : 0;

  return (
    <div className="v2-usage__totals" aria-busy={loading}>
      <Stat icon={Activity} label="Calls" value={formatNumber(calls)} />
      <Stat label="Input tokens" value={formatNumber(input)} />
      <Stat label="Output tokens" value={formatNumber(output)} />
      <Stat label="Total tokens" value={formatNumber(total)} highlight />
      <Stat label="Avg latency" value={avgLatency > 0 ? `${avgLatency} ms` : "—"} />
      <Stat label="Errors" value={String(errors)} tone={errors > 0 ? "warn" : "neutral"} />
    </div>
  );
}

function Stat({
  icon,
  label,
  value,
  tone,
  highlight,
}: {
  icon?: LucideIcon;
  label: string;
  value: string;
  tone?: "warn" | "neutral";
  highlight?: boolean;
}) {
  return (
    <div className="v2-usage__stat" data-tone={tone ?? "neutral"} data-highlight={highlight ? "true" : "false"}>
      <div className="v2-usage__stat-label">
        {icon && <Icon icon={icon} size="sm" />} {label}
      </div>
      <div className="v2-usage__stat-value">{value}</div>
    </div>
  );
}

// ─── Tables ───────────────────────────────────────────────────────────────

function GroupedTable({
  rows,
  groupBy,
  loading,
}: {
  rows: { key: string; calls: number; input_tokens: number; output_tokens: number; total_latency_ms: number; errors: number }[];
  groupBy: UsageGroupBy;
  loading: boolean;
}) {
  if (loading && rows.length === 0) {
    return <div className="v2-usage__empty">Loading…</div>;
  }
  if (rows.length === 0) {
    return <div className="v2-usage__empty">No usage in this period for the selected filters.</div>;
  }
  const keyHeader = groupBy === "tier" ? "Difficulty"
    : groupBy === "model" ? "Model"
    : groupBy === "subsystem" ? "Task"
    : groupBy === "provider" ? "Provider"
    : groupBy === "date" ? "Date"
    : "Group";

  return (
    <table className="v2-usage__table">
      <thead>
        <tr>
          <th>{keyHeader}</th>
          <th>Calls</th>
          <th>Input</th>
          <th>Output</th>
          <th>Total</th>
          <th>Avg latency</th>
          <th>Errors</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <td>{groupBy === "tier" ? (TIER_LABELS[r.key] ?? r.key) : r.key}</td>
            <td className="v2-usage__num">{formatNumber(r.calls)}</td>
            <td className="v2-usage__num">{formatNumber(r.input_tokens)}</td>
            <td className="v2-usage__num">{formatNumber(r.output_tokens)}</td>
            <td className="v2-usage__num v2-usage__num--strong">
              {formatNumber(r.input_tokens + r.output_tokens)}
            </td>
            <td className="v2-usage__num">
              {r.calls > 0 ? `${Math.round(r.total_latency_ms / r.calls)} ms` : "—"}
            </td>
            <td className="v2-usage__num" data-warn={r.errors > 0}>{r.errors}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function RawRowsTable({
  rows,
  truncated,
  loading,
}: {
  rows: UsageRawRow[];
  truncated?: boolean;
  loading: boolean;
}) {
  if (loading && rows.length === 0) return <div className="v2-usage__empty">Loading…</div>;
  if (rows.length === 0) return <div className="v2-usage__empty">No calls in this period.</div>;

  return (
    <>
      {truncated && (
        <div className="v2-usage__hint">
          Showing the 500 most recent rows. Narrow the period or add filters to see more.
        </div>
      )}
      <table className="v2-usage__table v2-usage__table--raw">
        <thead>
          <tr>
            <th>Time</th>
            <th>Difficulty</th>
            <th>Task</th>
            <th>Model</th>
            <th>Provider</th>
            <th>Input</th>
            <th>Output</th>
            <th>Latency</th>
            <th>Error</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.ts}-${i}`}>
              <td>{new Date(r.ts).toLocaleString()}</td>
              <td>{TIER_LABELS[r.tier] ?? r.tier}</td>
              <td>{r.subsystem}</td>
              <td>{r.model}</td>
              <td>{r.provider}</td>
              <td className="v2-usage__num">{formatNumber(r.input_tokens)}</td>
              <td className="v2-usage__num">{formatNumber(r.output_tokens)}</td>
              <td className="v2-usage__num">{r.latency_ms} ms</td>
              <td data-warn={!!r.error_code}>{r.error_code ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function formatNumber(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 2 : 1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

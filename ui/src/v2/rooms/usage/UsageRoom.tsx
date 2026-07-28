import React, { useMemo } from "react";
import { BarChart3, Calendar, RefreshCw, type LucideIcon } from "lucide-react";
import { Icon } from "../../ui";
import { Select, FilterChip, Check, Table, Row, Cell, HCell } from "../../ui/roomkit";
import { RoomShell } from "../RoomShell";
import { MultiSelectDropdown } from "./MultiSelectDropdown";
import { useUsageData, type UsageGroupBy, type UsagePeriod, type UsageRawRow } from "./useUsageData";
import "./UsageRoom.css";

const PERIOD_LABELS: Record<UsagePeriod, string> = {
  today: "Today", "7d": "Last 7 days", "30d": "Last 30 days",
  this_month: "This month", last_month: "Last month", custom: "Custom",
};
const GROUP_BY_LABELS: Record<UsageGroupBy, string> = {
  model: "Model", tier: "Difficulty (tier)", subsystem: "Task (subsystem)",
  provider: "Provider", date: "Date", none: "Raw rows",
};
const TIER_LABELS: Record<string, string> = { conversation: "Conversation", high: "High", medium: "Medium", low: "Low" };

export type RoomBodyMode = "inline" | "expanded";

export function UsageRoom() {
  return (
    <RoomShell title="Usage" subtitle="LLM token telemetry · filterable" breadcrumb={["Usage"]}>
      <UsageRoomBody mode="expanded" />
    </RoomShell>
  );
}

export function UsageRoomBody({ mode = "expanded" }: { mode?: RoomBodyMode } = {}) {
  void mode;
  const data = useUsageData();
  const total = data.result?.total;
  const grand = ((total?.input_tokens ?? 0) + (total?.cache_read_input_tokens ?? 0) + (total?.cache_creation_input_tokens ?? 0) + (total?.output_tokens ?? 0)) || 1;

  return (
    <div className="rk-usage">
      <FilterBar data={data} />
      <TotalsStrip totals={total} />
      <div className="rk-usage__main">
        {data.error && <div className="rk-usage__empty">{data.error}</div>}
        {data.filters.groupBy === "none" ? (
          <RawRowsTable rows={data.result?.raw ?? []} truncated={data.result?.raw_truncated} loading={data.loading} />
        ) : (
          <GroupedTable rows={data.result?.rows ?? []} groupBy={data.filters.groupBy} grand={grand} loading={data.loading} />
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
  const anyFilter = filters.tiers.length > 0 || filters.models.length > 0 || filters.subsystems.length > 0 || filters.providers.length > 0 || filters.errorsOnly;

  return (
    <div className="rk-usage__bar">
      <div className="rk-usage__row">
        <span className="rk-usage__title">Usage</span>
        <span className="rk-usage__sub">tokens · latency</span>
        <span style={{ marginLeft: "auto" }} />
        <button className="rk-usage__refresh" onClick={refresh} title="Refresh"><Icon icon={RefreshCw} size="sm" /> refresh</button>
      </div>

      <div className="rk-usage__row">
        <span className="rk-usage__lab"><Icon icon={Calendar} size="sm" /> period</span>
        <Select value={filters.period} onChange={(e) => setFilter("period", e.target.value as UsagePeriod)}>
          {(Object.keys(PERIOD_LABELS) as UsagePeriod[]).map((p) => <option key={p} value={p}>{PERIOD_LABELS[p]}</option>)}
        </Select>
        {filters.period === "custom" && (
          <>
            <input type="date" className="rk-usage__date" value={filters.customFrom ?? ""} onChange={(e) => setFilter("customFrom", e.target.value || null)} />
            <span className="rk-usage__period">→</span>
            <input type="date" className="rk-usage__date" value={filters.customTo ?? ""} onChange={(e) => setFilter("customTo", e.target.value || null)} />
          </>
        )}
        <span className="rk-usage__lab" style={{ marginLeft: 6 }}><Icon icon={BarChart3} size="sm" /> group by</span>
        <Select value={filters.groupBy} onChange={(e) => setFilter("groupBy", e.target.value as UsageGroupBy)}>
          {(Object.keys(GROUP_BY_LABELS) as UsageGroupBy[]).map((g) => <option key={g} value={g}>{GROUP_BY_LABELS[g]}</option>)}
        </Select>
        <span className="rk-usage__period">{periodSummary}</span>
      </div>

      {(options?.tiers?.length ?? 0) > 0 && (
        <div className="rk-usage__row">
          <span className="rk-usage__lab">difficulty</span>
          {(options?.tiers ?? []).map((v) => (
            <FilterChip key={v} on={filters.tiers.includes(v)} onClick={() => toggleListFilter("tiers", v)}>{TIER_LABELS[v] ?? v}</FilterChip>
          ))}
        </div>
      )}

      <div className="rk-usage__row">
        <MultiSelectDropdown label="Model" options={options?.models ?? []} selected={filters.models} onToggle={(v) => toggleListFilter("models", v)} onClear={() => setFilter("models", [])} />
        <MultiSelectDropdown label="Task" options={options?.subsystems ?? []} selected={filters.subsystems} onToggle={(v) => toggleListFilter("subsystems", v)} onClear={() => setFilter("subsystems", [])} />
        <MultiSelectDropdown label="Provider" options={options?.providers ?? []} selected={filters.providers} onToggle={(v) => toggleListFilter("providers", v)} onClear={() => setFilter("providers", [])} />
        <Check on={filters.errorsOnly} onClick={() => setFilter("errorsOnly", !filters.errorsOnly)}>errors only</Check>
        {anyFilter && <FilterChip onClick={clearFilters}>✕ clear filters</FilterChip>}
      </div>
    </div>
  );
}

// ─── Totals strip ─────────────────────────────────────────────────────────
function TotalsStrip({ totals }: { totals?: { calls: number; input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number; total_latency_ms: number; errors: number } }) {
  const calls = totals?.calls ?? 0;
  const input = totals?.input_tokens ?? 0;
  const output = totals?.output_tokens ?? 0;
  const cacheRead = totals?.cache_read_input_tokens ?? 0;
  const cacheWrite = totals?.cache_creation_input_tokens ?? 0;
  // input_tokens counts only uncached prompt tokens; the full prompt volume
  // is input + cache reads + cache writes.
  const total = input + cacheRead + cacheWrite + output;
  const cacheHitPct = input + cacheRead + cacheWrite > 0 ? Math.round((cacheRead / (input + cacheRead + cacheWrite)) * 100) : 0;
  const errors = totals?.errors ?? 0;
  const avg = calls > 0 ? Math.round((totals?.total_latency_ms ?? 0) / calls) : 0;
  const StatCell = ({ k, n, hi, tone }: { k: string; n: string; hi?: boolean; tone?: "amber" }) => (
    <div className={`rk-stats__cell${hi ? " rk-stats__cell--hi" : ""}`}>
      <div className="rk-stats__k">{k}</div>
      <div className={`rk-stats__n${tone ? " rk-stats__n--amber" : ""}`}>{n}</div>
    </div>
  );
  return (
    <div className="rk-stats">
      <StatCell k="calls" n={formatNumber(calls)} />
      <StatCell k="input" n={formatNumber(input)} />
      <StatCell k="cached" n={cacheRead > 0 ? `${formatNumber(cacheRead)} (${cacheHitPct}%)` : "—"} />
      <StatCell k="output" n={formatNumber(output)} />
      <StatCell k="total tokens" n={formatNumber(total)} hi />
      <StatCell k="avg latency" n={avg > 0 ? `${avg} ms` : "—"} />
      <StatCell k="errors" n={String(errors)} tone={errors > 0 ? "amber" : undefined} />
    </div>
  );
}

// ─── Tables ───────────────────────────────────────────────────────────────
const GROUP_COLS = "1.7fr 64px 74px 74px 74px 86px 92px 58px";

function GroupedTable({ rows, groupBy, grand, loading }: {
  rows: { key: string; calls: number; input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number; total_latency_ms: number; errors: number }[];
  groupBy: UsageGroupBy; grand: number; loading: boolean;
}) {
  if (loading && rows.length === 0) return <div className="rk-usage__empty">Loading…</div>;
  if (rows.length === 0) return <div className="rk-usage__empty">No usage in this period for the selected filters.</div>;
  const keyHeader = groupBy === "tier" ? "Difficulty" : groupBy === "subsystem" ? "Task" : groupBy === "model" ? "Model" : groupBy === "provider" ? "Provider" : groupBy === "date" ? "Date" : "Group";

  return (
    <Table label={`Usage grouped by ${keyHeader}`}>
      <Row cols={GROUP_COLS} head><HCell>{keyHeader}</HCell><HCell className="rk-num">calls</HCell><HCell className="rk-num">input</HCell><HCell className="rk-num">cached</HCell><HCell className="rk-num">output</HCell><HCell className="rk-num">total</HCell><HCell className="rk-num">latency</HCell><HCell className="rk-num">errors</HCell></Row>
      {rows.map((r) => {
        const tot = r.input_tokens + r.cache_read_input_tokens + r.cache_creation_input_tokens + r.output_tokens;
        const share = Math.max(2, Math.round((tot / grand) * 100));
        return (
          <Row key={r.key} cols={GROUP_COLS}>
            <Cell className="rk-usage__key">
              <span className="rk-usage__key-name"><b>{groupBy === "tier" ? TIER_LABELS[r.key] ?? r.key : r.key}</b></span>
              <span className="rk-usage__share" style={{ width: `${share}%` }} />
            </Cell>
            <Cell className="rk-num">{formatNumber(r.calls)}</Cell>
            <Cell className="rk-num">{formatNumber(r.input_tokens)}</Cell>
            <Cell className="rk-num">{r.cache_read_input_tokens > 0 ? formatNumber(r.cache_read_input_tokens) : "—"}</Cell>
            <Cell className="rk-num">{formatNumber(r.output_tokens)}</Cell>
            <Cell className="rk-num rk-num--tot">{formatNumber(tot)}</Cell>
            <Cell className="rk-num">{r.calls > 0 ? `${Math.round(r.total_latency_ms / r.calls)} ms` : "—"}</Cell>
            <Cell className={`rk-num${r.errors > 0 ? " rk-usage__err" : ""}`}>{r.errors}</Cell>
          </Row>
        );
      })}
    </Table>
  );
}

const RAW_COLS = "112px 88px 1.4fr 1.1fr 76px 64px 64px 64px 74px 84px";

function RawRowsTable({ rows, truncated, loading }: { rows: UsageRawRow[]; truncated?: boolean; loading: boolean }) {
  if (loading && rows.length === 0) return <div className="rk-usage__empty">Loading…</div>;
  if (rows.length === 0) return <div className="rk-usage__empty">No calls in this period.</div>;
  return (
    <>
      {truncated && <div className="rk-usage__hint">Showing the 500 most recent rows. Narrow the period or add filters to see more.</div>}
      <Table label="Raw usage rows">
        <Row cols={RAW_COLS} head><HCell>time</HCell><HCell>difficulty</HCell><HCell>task</HCell><HCell>model</HCell><HCell>provider</HCell><HCell className="rk-num">in</HCell><HCell className="rk-num">cached</HCell><HCell className="rk-num">out</HCell><HCell className="rk-num">latency</HCell><HCell className="rk-num">error</HCell></Row>
        {rows.map((r, i) => (
          <Row key={`${r.ts}-${i}`} cols={RAW_COLS}>
            <Cell className="rk-usage__raw-mono">{new Date(r.ts).toLocaleString()}</Cell>
            <Cell>{TIER_LABELS[r.tier] ?? r.tier}</Cell>
            <Cell className="rk-usage__raw-mono">{r.subsystem}</Cell>
            <Cell className="rk-usage__raw-mono">{r.model}</Cell>
            <Cell className="rk-usage__raw-mono">{r.provider}</Cell>
            <Cell className="rk-num">{formatNumber(r.input_tokens)}</Cell>
            <Cell className="rk-num">{r.cache_read_input_tokens > 0 ? formatNumber(r.cache_read_input_tokens) : "—"}</Cell>
            <Cell className="rk-num">{formatNumber(r.output_tokens)}</Cell>
            <Cell className="rk-num">{r.latency_ms} ms</Cell>
            <Cell className={`rk-num${r.error_code ? " rk-usage__err" : ""}`}>{r.error_code ?? ""}</Cell>
          </Row>
        ))}
      </Table>
    </>
  );
}

function formatNumber(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 2 : 1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLiveData } from "../../shell/LiveDataContext";

export type LogSource =
  | "awareness"
  | "authority"
  | "agents"
  | "tasks"
  | "sidecar";

export type LogTimeWindow = "1h" | "24h" | "7d" | "all";

export interface LogEntry {
  /** Stable id within its source — used for React keys and detail-pane lookup. */
  id: string;
  source: LogSource;
  title: string;
  /** Optional one-line summary shown in the list row. */
  summary?: string;
  /** Higher-resolution body shown in the detail pane. */
  detail?: string;
  /** Source-specific tags rendered as small pills (e.g. action_category). */
  tags?: string[];
  /** Tone used for the row icon and detail header chip. */
  tone: "ok" | "neutral" | "warn" | "accent";
  timestamp: number;
  /** Raw source row, surfaced in the detail pane as a JSON inspector. */
  raw: Record<string, unknown>;
}

const POLL_INTERVAL_MS = 5000;
const REST_LIMIT_OBSERVATIONS = 50;
const REST_LIMIT_AUDIT = 100;

const TIME_WINDOW_MS: Record<LogTimeWindow, number | null> = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  all: null,
};

interface ObservationRow {
  id: string;
  type: string;
  title: string;
  summary: string;
  created_at: number;
  data: Record<string, unknown>;
}

interface AuditRow {
  id: string;
  agent_id: string;
  agent_name: string;
  tool_name: string;
  action_category: string;
  authority_decision: "allowed" | "denied" | "approval_required";
  approval_id: string | null;
  executed: number;
  execution_time_ms: number | null;
  created_at: number;
}

/**
 * Load + maintain the unified Logs feed.
 *
 * REST sources (snapshot + 5s poll while live tail is on):
 *   - GET /api/vault/observations?summarized=true (awareness)
 *   - GET /api/authority/audit (authority)
 *
 * Live additions (always merged, regardless of live-tail toggle):
 *   - taskEvents, agentActivity, notices, approvals/clarifiers/repeatBacks
 *     from useLiveData (a thin context wrapper around useWebSocket).
 *
 * The split avoids a new daemon broadcast contract: live state we already
 * have streams in real-time; historical snapshots come from REST and only
 * refresh when the user explicitly asks (or live-tail polls).
 *
 * Live-tail OFF semantics: the snapshot is preserved as it was at the last
 * fetch; live additions still merge in (cheap, useful, no data loss). What
 * "off" actually means is "stop polling REST" — not "freeze the list".
 */
export function useLogsFeed() {
  const live = useLiveData();
  const [observations, setObservations] = useState<ObservationRow[]>([]);
  const [auditRows, setAuditRows] = useState<AuditRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [liveTail, setLiveTail] = useState(false);
  const [enabledSources, setEnabledSources] = useState<Set<LogSource>>(
    () => new Set<LogSource>(["awareness", "authority", "agents", "tasks", "sidecar"]),
  );
  const [timeWindow, setTimeWindow] = useState<LogTimeWindow>("24h");

  const inFlightRef = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const [obsResp, auditResp] = await Promise.all([
        fetch(`/api/vault/observations?summarized=true&limit=${REST_LIMIT_OBSERVATIONS}`),
        fetch(`/api/authority/audit?limit=${REST_LIMIT_AUDIT}`),
      ]);
      if (obsResp.ok) {
        const data = (await obsResp.json()) as ObservationRow[];
        setObservations(Array.isArray(data) ? data : []);
      }
      if (auditResp.ok) {
        const data = (await auditResp.json()) as AuditRow[];
        setAuditRows(Array.isArray(data) ? data : []);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load logs");
    } finally {
      inFlightRef.current = false;
      setLoading(false);
    }
  }, []);

  // Initial load.
  useEffect(() => {
    refresh();
  }, [refresh]);

  // Poll while live-tail is on. Pauses on tab-hidden so we don't churn
  // the daemon for off-screen tabs.
  useEffect(() => {
    if (!liveTail) return;
    const tick = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      refresh();
    };
    const id = window.setInterval(tick, POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [liveTail, refresh]);

  // Build the unified entry list from REST snapshots + live state.
  const allEntries = useMemo<LogEntry[]>(() => {
    const out: LogEntry[] = [];

    for (const o of observations) {
      out.push({
        id: `obs:${o.id}`,
        source: "awareness",
        title: o.title || o.type,
        summary: o.summary || undefined,
        detail: o.summary || undefined,
        tags: [o.type],
        tone: "neutral",
        timestamp: o.created_at,
        raw: o as unknown as Record<string, unknown>,
      });
    }

    for (const a of auditRows) {
      const denied = a.authority_decision === "denied";
      const pending = a.authority_decision === "approval_required";
      out.push({
        id: `audit:${a.id}`,
        source: "authority",
        title: `${a.agent_name} → ${a.tool_name}`,
        summary: `${a.authority_decision.replace("_", " ")} · ${a.action_category}`,
        detail:
          a.execution_time_ms != null
            ? `${a.tool_name} ran in ${a.execution_time_ms}ms (${a.action_category})`
            : `${a.tool_name} (${a.action_category})`,
        tags: [a.action_category, a.authority_decision],
        tone: denied ? "warn" : pending ? "accent" : "neutral",
        timestamp: a.created_at,
        raw: a as unknown as Record<string, unknown>,
      });
    }

    for (const t of live.taskEvents) {
      out.push({
        id: `task:${t.task.id}:${t.timestamp}`,
        source: "tasks",
        title: t.task.what || `Task ${t.action}`,
        summary: `${t.action} · ${t.task.status}`,
        detail: t.task.context || t.task.result || undefined,
        tags: [t.action, t.task.status, t.task.priority],
        tone:
          t.task.status === "failed"
            ? "warn"
            : t.task.status === "completed"
            ? "ok"
            : "neutral",
        timestamp: t.timestamp,
        raw: t as unknown as Record<string, unknown>,
      });
    }

    for (const a of live.agentActivity) {
      const isDone = a.eventType === "done";
      const isToolCall = a.eventType === "tool_call";
      const dataObj = (a.data && typeof a.data === "object" ? a.data : {}) as Record<string, unknown>;
      const summaryFromData =
        typeof dataObj.text === "string"
          ? (dataObj.text as string).slice(0, 80)
          : typeof dataObj.name === "string"
          ? `tool ${dataObj.name}`
          : a.eventType;
      out.push({
        id: `agent:${a.id}`,
        source: "agents",
        title: `${a.agentName}`,
        summary: `${a.eventType} · ${summaryFromData}`,
        detail:
          typeof dataObj.text === "string"
            ? (dataObj.text as string)
            : JSON.stringify(dataObj, null, 2),
        tags: [a.eventType, ...(isToolCall && typeof dataObj.name === "string" ? [String(dataObj.name)] : [])],
        tone: isDone ? "ok" : "neutral",
        timestamp: a.timestamp,
        raw: a as unknown as Record<string, unknown>,
      });
    }

    for (const n of live.notices) {
      out.push({
        id: `notice:${n.id}`,
        source: "sidecar",
        title: n.title,
        summary: n.text,
        detail: n.text,
        tags: [n.level],
        tone: "warn",
        timestamp: Date.now(),
        raw: n as unknown as Record<string, unknown>,
      });
    }

    out.sort((a, b) => b.timestamp - a.timestamp);
    return out;
  }, [observations, auditRows, live.taskEvents, live.agentActivity, live.notices]);

  // Apply user filters. Source filter set is always interior to the
  // useMemo so toggling sources doesn't trigger upstream re-fetching.
  const entries = useMemo(() => {
    const cutoff = TIME_WINDOW_MS[timeWindow];
    const minTs = cutoff != null ? Date.now() - cutoff : 0;
    return allEntries.filter(
      (e) => enabledSources.has(e.source) && e.timestamp >= minTs,
    );
  }, [allEntries, enabledSources, timeWindow]);

  const counts = useMemo(() => {
    const out: Record<LogSource, number> = {
      awareness: 0,
      authority: 0,
      agents: 0,
      tasks: 0,
      sidecar: 0,
    };
    for (const e of allEntries) out[e.source]++;
    return out;
  }, [allEntries]);

  const toggleSource = useCallback((s: LogSource) => {
    setEnabledSources((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      // Don't allow zero-source state — it'd render an empty list with no
      // recovery path other than the pills the user just dismissed.
      if (next.size === 0) return prev;
      return next;
    });
  }, []);

  return {
    entries,
    counts,
    error,
    loading,
    liveTail,
    setLiveTail,
    enabledSources,
    toggleSource,
    timeWindow,
    setTimeWindow,
    refresh,
  };
}

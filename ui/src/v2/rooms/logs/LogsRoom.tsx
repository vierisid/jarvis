import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  Eye,
  FileText,
  RefreshCw,
  ShieldAlert,
  Users,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { Chip, Icon } from "../../ui";
import { RoomShell } from "../RoomShell";
import { useRoomActions } from "../useRoomActionBus";
import { useLogsFeed, type LogEntry, type LogSource, type LogTimeWindow } from "./useLogsFeed";
import "./LogsRoom.css";

const VALID_SOURCES: ReadonlySet<LogSource> = new Set([
  "awareness",
  "authority",
  "agents",
  "tasks",
  "sidecar",
]);

const VALID_WINDOWS: ReadonlySet<LogTimeWindow> = new Set(["1h", "24h", "7d", "all"]);

const SOURCE_ORDER: LogSource[] = ["awareness", "authority", "agents", "tasks", "sidecar"];

const SOURCE_LABEL: Record<LogSource, string> = {
  awareness: "Awareness",
  authority: "Authority",
  agents: "Agents",
  tasks: "Tasks",
  sidecar: "Sidecar",
};

const SOURCE_ICON: Record<LogSource, LucideIcon> = {
  awareness: Eye,
  authority: ShieldAlert,
  agents: Users,
  tasks: FileText,
  sidecar: Activity,
};

const TIME_ORDER: LogTimeWindow[] = ["1h", "24h", "7d", "all"];

const TIME_LABEL: Record<LogTimeWindow, string> = {
  "1h": "Last hour",
  "24h": "Last day",
  "7d": "Last week",
  all: "All time",
};

export type RoomBodyMode = "inline" | "expanded";

/**
 * Logs Room body — works in both inline (RoomWindow card) and expanded
 * (RoomShell overlay) presentations. Inline mode collapses to list-only;
 * expanded mode shows the standard two-pane layout.
 */
export function LogsRoomBody({ mode }: { mode: RoomBodyMode }) {
  const feed = useLogsFeed();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // In expanded mode, keep something selected so the detail pane has
  // content. Inline mode leaves selection empty until the user picks.
  useEffect(() => {
    if (mode !== "expanded") return;
    if (feed.entries.length === 0) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !feed.entries.some((e) => e.id === selectedId)) {
      setSelectedId(feed.entries[0]!.id);
    }
  }, [feed.entries, selectedId, mode]);

  const selected = useMemo(
    () => (selectedId ? feed.entries.find((e) => e.id === selectedId) ?? null : null),
    [feed.entries, selectedId],
  );

  // Phase 6.3.5 — voice-driven Room actions.
  useRoomActions("logs", (action, args) => {
    switch (action) {
      case "toggle_source": {
        const s = String(args.source);
        if (VALID_SOURCES.has(s as LogSource)) {
          feed.toggleSource(s as LogSource);
          return true;
        }
        return false;
      }
      case "set_time_window": {
        const w = String(args.window);
        if (VALID_WINDOWS.has(w as LogTimeWindow)) {
          feed.setTimeWindow(w as LogTimeWindow);
          return true;
        }
        return false;
      }
      case "toggle_live_tail":
        feed.setLiveTail(!feed.liveTail);
        return true;
      case "refresh":
        feed.refresh();
        return true;
      default:
        return false;
    }
  });

  return (
    <div className={`v2-logs v2-logs--${mode}`}>
      <div className="v2-logs__list-pane">
        <div className="v2-logs__filters">
          <div className="v2-logs__filter-row" role="tablist" aria-label="Filter by source">
            {SOURCE_ORDER.map((s) => {
              const active = feed.enabledSources.has(s);
              const count = feed.counts[s];
              return (
                <button
                  key={s}
                  type="button"
                  className="v2-logs__filter-btn"
                  data-active={active}
                  onClick={() => feed.toggleSource(s)}
                  role="tab"
                  aria-selected={active}
                >
                  <Icon icon={SOURCE_ICON[s]} size="sm" />
                  <span>{SOURCE_LABEL[s]}</span>
                  {count > 0 && <span className="v2-logs__filter-count">{count}</span>}
                </button>
              );
            })}
          </div>

          <div className="v2-logs__bottom-row">
            <div
              className="v2-logs__time-row"
              role="tablist"
              aria-label="Filter by time window"
            >
              {TIME_ORDER.map((w) => (
                <button
                  key={w}
                  type="button"
                  className="v2-logs__time-btn"
                  data-active={feed.timeWindow === w}
                  onClick={() => feed.setTimeWindow(w)}
                  role="tab"
                  aria-selected={feed.timeWindow === w}
                >
                  {TIME_LABEL[w]}
                </button>
              ))}
            </div>

            <div className="v2-logs__actions">
              <button
                type="button"
                className="v2-logs__live-toggle"
                data-active={feed.liveTail}
                onClick={() => feed.setLiveTail(!feed.liveTail)}
                aria-pressed={feed.liveTail}
                title={feed.liveTail ? "Live tail on (polls every 5s)" : "Live tail off"}
              >
                <span className="v2-logs__live-dot" data-active={feed.liveTail} aria-hidden="true" />
                Live
              </button>
              <button
                type="button"
                className="v2-logs__refresh"
                onClick={feed.refresh}
                aria-label="Refresh"
                title="Refresh"
              >
                <Icon icon={RefreshCw} size="sm" />
              </button>
            </div>
          </div>
        </div>

        {feed.error && <div className="v2-logs__error">{feed.error}</div>}
        {!feed.error && feed.loading && feed.entries.length === 0 && (
          <div className="v2-logs__empty">Loading…</div>
        )}
        {!feed.error && !feed.loading && feed.entries.length === 0 && (
          <div className="v2-logs__empty">
            No events for the current filters.
          </div>
        )}

        <ul className="v2-logs__list" role="listbox" aria-label="Log entries">
          {feed.entries.map((e) => {
            const active = selectedId === e.id;
            return (
              <li
                key={e.id}
                className="v2-logs__row"
                data-active={active}
                data-tone={e.tone}
                onClick={() => setSelectedId(active ? null : e.id)}
                role="option"
                aria-selected={active}
              >
                <div className="v2-logs__row-icon">
                  <Icon icon={SOURCE_ICON[e.source]} size="sm" />
                </div>
                <div className="v2-logs__row-body">
                  <div className="v2-logs__row-head">
                    <span className="v2-logs__row-title">{e.title}</span>
                    <span className="v2-logs__row-time">{formatTime(e.timestamp)}</span>
                  </div>
                  {e.summary && <div className="v2-logs__row-summary">{e.summary}</div>}
                  {e.tags && e.tags.length > 0 && (
                    <div className="v2-logs__row-tags">
                      {e.tags.slice(0, 3).map((t) => (
                        <span key={t} className="v2-logs__tag">
                          {t}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      {mode === "expanded" && (
        <div className="v2-logs__detail-pane">
          {selected ? (
            <LogDetail entry={selected} />
          ) : (
            <div className="v2-logs__detail-empty">
              Select an event to inspect it.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Overlay-mode wrapper. Direct URL / Shift+Enter / explicit "expand". */
export function LogsRoom() {
  return (
    <RoomShell title="Logs" subtitle="events · awareness · audit" breadcrumb={["Logs"]}>
      <LogsRoomBody mode="expanded" />
    </RoomShell>
  );
}

function LogDetail({ entry }: { entry: LogEntry }) {
  const fullTimestamp = new Date(entry.timestamp).toLocaleString();
  const sourceTone: Record<LogEntry["tone"], "ok" | "neutral" | "warn" | "accent"> = {
    ok: "ok",
    neutral: "neutral",
    warn: "warn",
    accent: "accent",
  };

  return (
    <div className="v2-logs__detail">
      <div className="v2-logs__detail-head">
        <div className="v2-logs__detail-title-row">
          <h2 className="v2-logs__detail-title">{entry.title}</h2>
          <Chip tone={sourceTone[entry.tone]} dot={false}>
            {SOURCE_LABEL[entry.source]}
          </Chip>
        </div>
        <div className="v2-logs__detail-meta">
          <span>{fullTimestamp}</span>
        </div>
      </div>

      {entry.detail && <p className="v2-logs__detail-desc">{entry.detail}</p>}

      {entry.tags && entry.tags.length > 0 && (
        <div className="v2-logs__detail-section">
          <div className="v2-logs__detail-section-label">Tags</div>
          <div className="v2-logs__detail-tags">
            {entry.tags.map((t) => (
              <span key={t} className="v2-logs__tag">
                {t}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="v2-logs__detail-section">
        <div className="v2-logs__detail-section-label">Raw</div>
        <pre className="v2-logs__detail-raw">{formatRaw(entry.raw)}</pre>
      </div>
    </div>
  );
}

function formatTime(ts: number): string {
  if (!Number.isFinite(ts)) return "";
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function formatRaw(raw: Record<string, unknown>): string {
  try {
    return JSON.stringify(raw, null, 2);
  } catch {
    return "// raw payload not serializable";
  }
}

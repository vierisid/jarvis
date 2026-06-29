import React, { useEffect, useMemo, useState } from "react";
import { Activity, Eye, FileText, RefreshCw, ShieldAlert, Users, type LucideIcon } from "lucide-react";
import { Icon } from "../../ui";
import {
  StatusChip, StatusIcon, Drawer, DrawerLabel, DrawerText, DeepLink, Segmented, LiveToggle, EmptyState, Skeleton,
  type Tone,
} from "../../ui/roomkit";
import { RoomShell } from "../RoomShell";
import { openRoom, type RoomKey } from "../../router";
import { useRoomActions } from "../useRoomActionBus";
import { useLogsFeed, type LogEntry, type LogSource, type LogTimeWindow } from "./useLogsFeed";
import "./LogsRoom.css";

const VALID_SOURCES: ReadonlySet<LogSource> = new Set(["awareness", "authority", "agents", "tasks", "sidecar"]);
const VALID_WINDOWS: ReadonlySet<LogTimeWindow> = new Set(["1h", "24h", "7d", "all"]);
const SOURCE_ORDER: LogSource[] = ["awareness", "authority", "agents", "tasks", "sidecar"];
const SOURCE_LABEL: Record<LogSource, string> = { awareness: "Awareness", authority: "Authority", agents: "Agents", tasks: "Tasks", sidecar: "Sidecar" };
const SOURCE_ICON: Record<LogSource, LucideIcon> = { awareness: Eye, authority: ShieldAlert, agents: Users, tasks: FileText, sidecar: Activity };
const TIME_ORDER: LogTimeWindow[] = ["1h", "24h", "7d", "all"];
const TIME_SHORT: Record<LogTimeWindow, string> = { "1h": "1h", "24h": "24h", "7d": "7d", all: "all" };

// Tone, remapped to the five-tone system (logs §03).
const TONE_MAP: Record<LogEntry["tone"], Tone> = { ok: "ok", neutral: "mut", warn: "hold", accent: "fail" };

// "Doors to origin" (logs §04) — a source row walks you to its room.
const SOURCE_DOOR: Partial<Record<LogSource, { room: RoomKey; label: string }>> = {
  authority: { room: "authority", label: "Authority" },
  agents: { room: "agents", label: "Agents" },
  tasks: { room: "tasks", label: "Tasks" },
  awareness: { room: "memory", label: "Memory" },
};

export type RoomBodyMode = "inline" | "expanded";

/** Logs Room body — two-pane (stream + inspector) expanded, list-only inline. */
export function LogsRoomBody({ mode }: { mode: RoomBodyMode }) {
  const feed = useLogsFeed();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    if (mode !== "expanded") return;
    if (feed.entries.length === 0) { setSelectedId(null); return; }
    if (!selectedId || !feed.entries.some((e) => e.id === selectedId)) setSelectedId(feed.entries[0]!.id);
  }, [feed.entries, selectedId, mode]);

  const selected = useMemo(
    () => (selectedId ? feed.entries.find((e) => e.id === selectedId) ?? null : null),
    [feed.entries, selectedId],
  );

  useRoomActions("logs", (action, args) => {
    switch (action) {
      case "toggle_source": { const s = String(args.source); if (VALID_SOURCES.has(s as LogSource)) { feed.toggleSource(s as LogSource); return true; } return false; }
      case "set_time_window": { const w = String(args.window); if (VALID_WINDOWS.has(w as LogTimeWindow)) { feed.setTimeWindow(w as LogTimeWindow); return true; } return false; }
      case "toggle_live_tail": feed.setLiveTail(!feed.liveTail); return true;
      case "refresh": feed.refresh(); return true;
      default: return false;
    }
  });

  return (
    <div className={`rk-logs rk-logs--${mode}`}>
      <div className="rk-logs__list">
        <div className="rk-logs__bar">
          <div className="rk-logs__sources" role="group" aria-label="Filter by source">
            {SOURCE_ORDER.map((s) => {
              const active = feed.enabledSources.has(s);
              const count = feed.counts[s];
              return (
                <button
                  key={s}
                  className={`rk-filterchip rk-logs__src${active ? " rk-filterchip--on" : ""}`}
                  onClick={() => feed.toggleSource(s)}
                  aria-pressed={active}
                >
                  <Icon icon={SOURCE_ICON[s]} size="sm" />
                  {SOURCE_LABEL[s]}
                  {count > 0 && <span className="rk-logs__count">{count}</span>}
                </button>
              );
            })}
          </div>
          <div className="rk-logs__controls">
            <Segmented
              options={TIME_ORDER.map((w) => ({ key: w, label: TIME_SHORT[w] }))}
              value={feed.timeWindow}
              onChange={(w) => feed.setTimeWindow(w as LogTimeWindow)}
            />
            <span style={{ marginLeft: "auto" }} />
            <LiveToggle on={feed.liveTail} onClick={() => feed.setLiveTail(!feed.liveTail)} />
            <button className="rk-logs__refresh" onClick={feed.refresh} aria-label="Refresh" title="Refresh">
              <Icon icon={RefreshCw} size="sm" />
            </button>
          </div>
        </div>

        <div className="rk-logs__scroll" role="listbox" aria-label="Log entries">
          {feed.error ? (
            <div className="rk-logs__msg">{feed.error}</div>
          ) : feed.loading && feed.entries.length === 0 ? (
            <div className="rk-logs__scroll-pad"><Skeleton lines={6} /></div>
          ) : feed.entries.length === 0 ? (
            <div className="rk-logs__scroll-pad">
              <EmptyState title="No events for these filters">
                Awareness, agents, authority, tasks, and the sidecar all report here. Widen the window or clear a source filter.
              </EmptyState>
            </div>
          ) : (
            feed.entries.map((e) => {
              const active = selectedId === e.id;
              return (
                <button
                  key={e.id}
                  className={`rk-logrow${active ? " rk-logrow--sel" : ""}`}
                  onClick={() => setSelectedId(active ? null : e.id)}
                  role="option"
                  aria-selected={active}
                >
                  <StatusIcon tone={TONE_MAP[e.tone]} />
                  <span className="rk-logrow__body">
                    <span className="rk-logrow__title"><b>{SOURCE_LABEL[e.source]}</b> · {e.title}</span>
                    {e.summary && <span className="rk-logrow__sum">{e.summary}</span>}
                    {e.tags && e.tags.length > 0 && (
                      <span className="rk-logrow__tags">
                        {e.tags.slice(0, 3).map((t) => <span key={t} className="rk-logtag">{t}</span>)}
                      </span>
                    )}
                  </span>
                  <span className="rk-logrow__time">{formatTime(e.timestamp)}</span>
                </button>
              );
            })
          )}
        </div>
      </div>

      {mode === "expanded" && (
        <div className="rk-logs__detail">
          {selected ? <LogDetail entry={selected} /> : <Drawer empty="Select an event to inspect it." />}
        </div>
      )}
    </div>
  );
}

/** Overlay wrapper — kept for panel/direct-URL use (the shell renders the body). */
export function LogsRoom() {
  return (
    <RoomShell title="Logs" subtitle="events · awareness · audit" breadcrumb={["Logs"]}>
      <LogsRoomBody mode="expanded" />
    </RoomShell>
  );
}

function LogDetail({ entry }: { entry: LogEntry }) {
  const door = SOURCE_DOOR[entry.source];
  return (
    <Drawer
      title={entry.title}
      meta={<><StatusChip tone={TONE_MAP[entry.tone]}>{SOURCE_LABEL[entry.source]}</StatusChip><span>{new Date(entry.timestamp).toLocaleString()}</span></>}
      actions={door ? <DeepLink onClick={() => openRoom(door.room)}>→ open in {door.label}</DeepLink> : undefined}
    >
      {entry.detail && <><DrawerLabel>detail</DrawerLabel><DrawerText>{entry.detail}</DrawerText></>}
      {entry.tags && entry.tags.length > 0 && (
        <>
          <DrawerLabel>tags</DrawerLabel>
          <div className="rk-logs__detail-tags">{entry.tags.map((t) => <span key={t} className="rk-logtag">{t}</span>)}</div>
        </>
      )}
      <DrawerLabel>raw</DrawerLabel>
      <div className="rk-drawer__raw">{formatRaw(entry.raw)}</div>
    </Drawer>
  );
}

function formatTime(ts: number): string {
  if (!Number.isFinite(ts)) return "";
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function formatRaw(raw: Record<string, unknown>): string {
  try { return JSON.stringify(raw, null, 2); } catch { return "// raw payload not serializable"; }
}

import React, { useCallback, useEffect, useRef, useState } from "react";
import { closeRoom, openRoom, useV2Route, type RoomKey } from "../router";
import { useLiveData } from "./LiveDataContext";

/**
 * The Index — Brand Book III room-centric sidebar. Three states:
 *  · expanded (212px): every room named, ⌘1–9 etched, live badges
 *  · collapsed (64px): five cluster tiles, badges bubble up to the cluster
 *  · peek: hovering a collapsed cluster reveals its rooms as a glass column
 *
 * "Now" is the home route (no room key); every other row navigates a Room
 * via the existing hash router, so daemon/voice navigation stays identical.
 */

type Row =
  | { kind: "heading"; label: string }
  | { kind: "room"; key: RoomKey; label: string; kbd?: string; spaced?: boolean }
  | { kind: "now"; label: string; kbd: string };

const ROWS: Row[] = [
  { kind: "now", label: "Now", kbd: "⌘1" },
  { kind: "heading", label: "run" },
  { kind: "room", key: "workflows", label: "Workflows", kbd: "⌘2" },
  { kind: "room", key: "agents", label: "Agents", kbd: "⌘3" },
  { kind: "room", key: "tasks", label: "Tasks", kbd: "⌘4" },
  { kind: "heading", label: "know" },
  { kind: "room", key: "memory", label: "Memory", kbd: "⌘5" },
  { kind: "room", key: "goals", label: "Goals", kbd: "⌘6" },
  { kind: "room", key: "calendar", label: "Calendar", kbd: "⌘7" },
  { kind: "room", key: "content", label: "Content", kbd: "⌘8" },
  { kind: "heading", label: "guard" },
  { kind: "room", key: "authority", label: "Authority" },
  { kind: "room", key: "logs", label: "Logs" },
  { kind: "room", key: "usage", label: "Usage" },
  { kind: "heading", label: "build" },
  { kind: "room", key: "workspaces", label: "Workspaces" },
  { kind: "room", key: "tools", label: "Tools" },
  { kind: "room", key: "settings", label: "Settings", kbd: "⌘9", spaced: true },
];

/** Cluster → its rooms, for collapsed tiles + hover-peek. */
const CLUSTERS: { id: string; ic: string; label: string; lead: RoomKey | "now"; rooms: { key: RoomKey; label: string }[] }[] = [
  { id: "now", ic: "◉", label: "Now", lead: "now", rooms: [] },
  { id: "run", ic: "▶", label: "Run", lead: "workflows", rooms: [
    { key: "workflows", label: "Workflows" }, { key: "agents", label: "Agents" }, { key: "tasks", label: "Tasks" } ] },
  { id: "know", ic: "◆", label: "Know", lead: "memory", rooms: [
    { key: "memory", label: "Memory" }, { key: "goals", label: "Goals" }, { key: "calendar", label: "Calendar" }, { key: "content", label: "Content" } ] },
  { id: "guard", ic: "▣", label: "Guard", lead: "authority", rooms: [
    { key: "authority", label: "Authority" }, { key: "logs", label: "Logs" }, { key: "usage", label: "Usage" } ] },
  { id: "build", ic: "⌗", label: "Build", lead: "workspaces", rooms: [
    { key: "workspaces", label: "Workspaces" }, { key: "tools", label: "Tools" } ] },
  { id: "sys", ic: "⚙", label: "Sys", lead: "settings", rooms: [{ key: "settings", label: "Settings" }] },
];

// ⌘1–9 → navigation target, in row order.
const HOTKEYS: (RoomKey | "now")[] = [
  "now", "workflows", "agents", "tasks", "memory", "goals", "calendar", "content", "settings",
];

const COLLAPSE_KEY = "jarvis-index-collapsed";

function navTo(target: RoomKey | "now") {
  if (target === "now") closeRoom();
  else openRoom(target);
}

export function IndexSidebar({
  collapsed,
  onToggleCollapse,
}: {
  collapsed: boolean;
  onToggleCollapse: () => void;
}) {
  const route = useV2Route();
  const live = useLiveData();
  const activeKey: RoomKey | "now" = route.kind === "room" ? route.key : "now";

  // Live badges: pending approvals → Authority (amber); system failures → Logs (red).
  const approvalCount = live.approvals.length;
  const failureCount = live.notices.length;
  const badgeFor = (key: RoomKey): { tone: "amber" | "red"; count: number } | null => {
    if (key === "authority" && approvalCount > 0) return { tone: "amber", count: approvalCount };
    if (key === "logs" && failureCount > 0) return { tone: "red", count: failureCount };
    return null;
  };
  // Loudest badge inside a cluster bubbles up to its collapsed tile.
  const clusterBadge = (rooms: { key: RoomKey }[]): "amber" | "red" | null => {
    let tone: "amber" | "red" | null = null;
    for (const r of rooms) {
      const b = badgeFor(r.key);
      if (b?.tone === "red") return "red";
      if (b?.tone === "amber") tone = "amber";
    }
    return tone;
  };

  // ⌘1–9 room navigation. Skipped in editable fields, and left to the browser
  // (tab switching) unless the shell actually has a room bound to that digit.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      const n = parseInt(e.key, 10);
      const target = n >= 1 && n <= 9 ? HOTKEYS[n - 1] : undefined;
      if (target) {
        e.preventDefault();
        navTo(target);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Hover-peek for collapsed clusters. Separate open (150ms) and close
  // (180ms) timers so the cursor can travel from the tile to the peek
  // column without it vanishing — the peek touches the rail (no gap) and
  // entering it cancels the pending close.
  const [peek, setPeek] = useState<{ id: string; top: number } | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTimers = () => {
    if (openTimer.current) clearTimeout(openTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
    openTimer.current = closeTimer.current = null;
  };
  const onTileEnter = useCallback((id: string, el: HTMLElement) => {
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; }
    const cluster = CLUSTERS.find((c) => c.id === id);
    if (!cluster || cluster.rooms.length === 0) {
      if (openTimer.current) { clearTimeout(openTimer.current); openTimer.current = null; }
      return;
    }
    if (openTimer.current) clearTimeout(openTimer.current);
    const top = el.getBoundingClientRect().top;
    openTimer.current = setTimeout(() => setPeek({ id, top }), 150);
  }, []);
  const scheduleClose = useCallback(() => {
    if (openTimer.current) { clearTimeout(openTimer.current); openTimer.current = null; }
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setPeek(null), 180);
  }, []);
  const cancelClose = useCallback(() => {
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; }
  }, []);
  useEffect(() => () => clearTimers(), []);
  useEffect(() => { if (!collapsed) { clearTimers(); setPeek(null); } }, [collapsed]);

  const peekCluster = peek ? CLUSTERS.find((c) => c.id === peek.id) : null;

  return (
    <nav className="rs-side" aria-label="Index">
      {/* Expanded */}
      <div className="rs-full">
        <div className="rs-brand">
          <div className="lg"><div className="r" /></div>
          <span className="w"><span>use</span>jarvis</span>
        </div>
        {ROWS.map((row, i) => {
          if (row.kind === "heading") return <div className="rs-gh" key={`h${i}`}>{row.label}</div>;
          const target: RoomKey | "now" = row.kind === "now" ? "now" : row.key;
          const isOn = activeKey === target;
          const badge = row.kind === "room" ? badgeFor(row.key) : null;
          return (
            <button
              key={target}
              className={`rs-item${isOn ? " on" : ""}`}
              style={row.kind === "room" && row.spaced ? { marginTop: 6 } : undefined}
              aria-current={isOn ? "page" : undefined}
              onClick={() => navTo(target)}
            >
              {row.label}
              {badge ? (
                <span className={`rs-badge ${badge.tone}`} aria-label={`${row.label}, ${badge.count} ${badge.tone === "amber" ? "waiting" : "failing"}`}>
                  {badge.count}
                </span>
              ) : (
                row.kbd && <kbd>{row.kbd}</kbd>
              )}
            </button>
          );
        })}
        <div style={{ flex: 1 }} />
        <button className="rs-clps" onClick={onToggleCollapse}>« collapse</button>
      </div>

      {/* Collapsed cluster tiles */}
      <div className="rs-slim">
        <div className="rs-brand"><div className="lg"><div className="r" /></div></div>
        {CLUSTERS.map((c) => {
          const isOn = c.lead === activeKey || c.rooms.some((r) => r.key === activeKey);
          const tone = clusterBadge(c.rooms);
          return (
            <button
              key={c.id}
              className={`rs-ct${isOn ? " on" : ""}`}
              style={c.id === "sys" ? { marginTop: 6 } : undefined}
              onClick={() => navTo(c.lead)}
              onMouseEnter={(e) => onTileEnter(c.id, e.currentTarget)}
              onMouseLeave={scheduleClose}
              aria-current={isOn ? "page" : undefined}
            >
              <span className="ic">{c.ic}</span>
              <span className="lb">{c.label}</span>
              {tone && <span className={`bd ${tone}`} />}
            </button>
          );
        })}
        <div style={{ flex: 1 }} />
        <button className="rs-clps" onClick={onToggleCollapse} aria-label="Expand sidebar">»</button>
      </div>

      {/* Hover peek */}
      {collapsed && peekCluster && peek && (
        <div className="rs-peek" style={{ top: peek.top }} onMouseEnter={cancelClose} onMouseLeave={scheduleClose}>
          <div className="fh">{peekCluster.label.toLowerCase()}</div>
          {peekCluster.rooms.map((r) => (
            <button key={r.key} onClick={() => { navTo(r.key); setPeek(null); }}>{r.label}</button>
          ))}
        </div>
      )}
    </nav>
  );
}

/** Persisted collapse state, shared by the shell. */
export function useIndexCollapsed(): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(COLLAPSE_KEY) === "1"; } catch { return false; }
  });
  const toggle = useCallback(() => {
    setCollapsed((c) => {
      const next = !c;
      try { localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0"); } catch { /* ignore */ }
      return next;
    });
  }, []);
  return [collapsed, toggle];
}

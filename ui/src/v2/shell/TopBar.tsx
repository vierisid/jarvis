import React from "react";
import { useV2Route } from "../router";
import { ROOM_NAV_ENTRIES } from "../palette/types";
import type { ConnectionState } from "./Header";
import { useTheme } from "./useTheme";
import { JapaneseDateTime } from "../core/JapaneseDateTime";
import type { JarvisCoreState } from "../core/coreState";

/**
 * Top bar — 44px, never two rows. Left: room name + contextual actions
 * (Now contributes Arrange). Right: the daemon dot, the live state chip,
 * Quick open (⌘K), and the bell. The state chip is the only live colour.
 */

const ROOM_TITLES: Record<string, string> = Object.fromEntries(
  ROOM_NAV_ENTRIES.map((e) => [e.key, e.label]),
);

const CORE_HUE: Record<JarvisCoreState, string> = {
  SLEEPING: "var(--faint)",
  AWAKENING: "var(--ink2)",
  IDLE: "var(--faint)",
  LISTENING: "var(--listen)",
  THINKING: "var(--ink2)",
  WORKING: "var(--speak)",
  WAITING_APPROVAL: "var(--hold)",
  SPEAKING: "var(--speak)",
  ERROR: "var(--listen)",
};

const DAEMON: Record<ConnectionState, { cls: string; hue: string; label: string }> = {
  live: { cls: "", hue: "var(--ok)", label: "システム · オンライン" },
  degraded: { cls: "hold", hue: "var(--hold)", label: "システム · 再接続中" },
  offline: { cls: "bad", hue: "var(--listen)", label: "オフライン" },
};

export function TopBar({
  connection,
  coreState,
  arranging,
  onArrange,
  onOpenPalette,
  notificationCount,
  notificationsOpen,
  onToggleNotifications,
}: {
  connection: ConnectionState;
  coreState: JarvisCoreState;
  arranging: boolean;
  onArrange: () => void;
  onOpenPalette: () => void;
  notificationCount?: number;
  notificationsOpen?: boolean;
  onToggleNotifications?: () => void;
}) {
  const route = useV2Route();
  const [theme, toggleTheme] = useTheme();
  const isNow = route.kind !== "room";
  const title = route.kind === "room" ? ROOM_TITLES[route.key] ?? route.key : "現在";
  const daemon = DAEMON[connection];
  const count = notificationCount ?? 0;

  return (
    <div className={`rs-top${connection === "offline" ? " off" : ""}`}>
      <span className="rm">{title}</span>
      {isNow && (
        <button className={`rs-abtn${arranging ? " on" : ""}`} onClick={onArrange} aria-pressed={arranging}>
          {arranging ? "完了" : "配置変更"}
        </button>
      )}

      <div className="right">
        <JapaneseDateTime />
        <span className={`rs-chip ${daemon.cls}`}>
          <span className="rs-dot" style={{ background: daemon.hue }} />
          {daemon.label}
        </span>

        {connection !== "offline" && (
          <span className="rs-chip hold" aria-live="polite">
            <span className="rs-dot" style={{ background: CORE_HUE[coreState] }} />
            <span className="rs-stl">CORE · {coreState}</span>
          </span>
        )}

        <button
          className="rs-chip"
          onClick={() => toggleTheme()}
          aria-label={`${theme === "dark" ? "ライト" : "ダーク"}モードへ切り替え`}
          title={`${theme === "dark" ? "ライト" : "ダーク"}モードへ切り替え`}
        >
          {theme === "dark" ? "● dark" : "○ light"}
        </button>

        <button className="rs-chip" onClick={onOpenPalette} aria-label="クイックオープン">⌘K</button>

        {onToggleNotifications && (
          <button
            className={`rs-bell${notificationsOpen ? " on" : ""}`}
            onClick={onToggleNotifications}
            aria-label={`Notifications${count > 0 ? `, ${count} unread` : ""}`}
            aria-expanded={notificationsOpen}
          >
            <span className="bb">⌥N</span>
            {count > 0 && <span className="bn">{count > 9 ? "9+" : count}</span>}
          </button>
        )}
      </div>
    </div>
  );
}

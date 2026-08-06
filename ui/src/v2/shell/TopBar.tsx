import React from "react";
import { useV2Route } from "../router";
import { ROOM_NAV_ENTRIES } from "../palette/types";
import type { ConnectionState } from "./Header";
import type { VoiceState } from "./VoiceRail";
import { useTheme } from "./useTheme";
import { useI18n } from "../i18n/I18nProvider";
import type { MessageKey } from "../i18n/translations";

/**
 * Top bar — 44px, never two rows. Left: room name + contextual actions
 * (Now contributes Arrange). Right: the daemon dot, the live state chip,
 * Quick open (⌘K), and the bell. The state chip is the only live colour.
 */

const ROOM_TITLE_KEYS: Record<string, MessageKey> = Object.fromEntries(
  ROOM_NAV_ENTRIES.map((e) => [e.key, `room.${e.key}` as MessageKey]),
);

const STATE_LABEL: Record<VoiceState, MessageKey> = {
  idle: "top.idle",
  listening: "top.listening",
  thinking: "top.thinking",
  speaking: "top.speaking",
  "awaiting-approval": "top.asking",
  muted: "top.muted",
};

const STATE_HUE: Record<VoiceState, string> = {
  idle: "var(--faint)",
  listening: "var(--listen)",
  thinking: "var(--ink2)",
  speaking: "var(--speak)",
  "awaiting-approval": "var(--hold)",
  muted: "var(--faint)",
};

const DAEMON: Record<ConnectionState, { cls: string; hue: string; labelKey: MessageKey }> = {
  live: { cls: "", hue: "var(--ok)", labelKey: "top.daemonOnline" },
  degraded: { cls: "hold", hue: "var(--hold)", labelKey: "top.daemonDegraded" },
  offline: { cls: "bad", hue: "var(--listen)", labelKey: "top.offline" },
};

export function TopBar({
  connection,
  voiceState,
  arranging,
  onArrange,
  onOpenPalette,
  notificationCount,
  notificationsOpen,
  onToggleNotifications,
}: {
  connection: ConnectionState;
  voiceState: VoiceState;
  arranging: boolean;
  onArrange: () => void;
  onOpenPalette: () => void;
  notificationCount?: number;
  notificationsOpen?: boolean;
  onToggleNotifications?: () => void;
}) {
  const route = useV2Route();
  const [theme, toggleTheme] = useTheme();
  const { t } = useI18n();
  const isNow = route.kind !== "room";
  const titleKey = route.kind === "room" ? ROOM_TITLE_KEYS[route.key] : "nav.now";
  const title = titleKey ? t(titleKey) : route.kind === "room" ? route.key : t("nav.now");
  const daemon = DAEMON[connection];
  const count = notificationCount ?? 0;

  return (
    <div className={`rs-top${connection === "offline" ? " off" : ""}`}>
      <span className="rm">{title}</span>
      {isNow && (
        <button className={`rs-abtn${arranging ? " on" : ""}`} onClick={onArrange} aria-pressed={arranging}>
          {t(arranging ? "top.done" : "top.arrange")}
        </button>
      )}

      <div className="right">
        <span className={`rs-chip ${daemon.cls}`}>
          <span className="rs-dot" style={{ background: daemon.hue }} />
          {t(daemon.labelKey)}
        </span>

        {connection !== "offline" && (
          <span className="rs-chip hold" aria-live="polite">
            <span className="rs-dot" style={{ background: STATE_HUE[voiceState] }} />
            <span className="rs-stl">{t(STATE_LABEL[voiceState])}</span>
          </span>
        )}

        <button
          className="rs-chip"
          onClick={() => toggleTheme()}
          aria-label={t(theme === "dark" ? "top.switchLight" : "top.switchDark")}
          title={t(theme === "dark" ? "top.switchLight" : "top.switchDark")}
        >
          {theme === "dark" ? `● ${t("top.dark")}` : `○ ${t("top.light")}`}
        </button>

        <button className="rs-chip" onClick={onOpenPalette} aria-label={t("top.quickOpen")}>⌘K</button>

        {onToggleNotifications && (
          <button
            className={`rs-bell${notificationsOpen ? " on" : ""}`}
            onClick={onToggleNotifications}
            aria-label={`${t("notifications.title")}${count > 0 ? `, ${t("notifications.unread", { count })}` : ""}`}
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

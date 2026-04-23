import React from "react";
import { Bell, ChevronDown, Search } from "lucide-react";
import { Button, Icon, KBD } from "../ui";
import { disableV2 } from "../flag";
import "./Header.css";

export type ConnectionState = "live" | "degraded" | "offline";
export type Mode = "active" | "passive" | "off";

const CONNECTION_LABEL: Record<ConnectionState, string> = {
  live: "Online",
  degraded: "Degraded",
  offline: "Offline",
};

const MODES: Mode[] = ["active", "passive", "off"];

export interface HeaderProps {
  connection?: ConnectionState;
  mode?: Mode;
  onModeChange?: (next: Mode) => void;
  onPalette?: () => void;
  hasNotifications?: boolean;
  identity?: string;
}

export function Header({
  connection = "live",
  mode = "active",
  onModeChange,
  onPalette,
  hasNotifications = false,
  identity = "Today · morning",
}: HeaderProps) {
  return (
    <header className="v2-header" role="banner">
      <div className="v2-header__left">
        <div className="v2-header__j" aria-label="Jarvis">J</div>
        <button type="button" className="v2-header__identity">
          {identity}
          <Icon icon={ChevronDown} size="sm" />
        </button>
        <span className="v2-header__connection" aria-label={`Connection ${CONNECTION_LABEL[connection]}`}>
          <span className={`v2-header__conn-dot v2-header__conn-dot--${connection}`} aria-hidden="true" />
          {CONNECTION_LABEL[connection]}
        </span>
      </div>

      <div className="v2-header__right">
        <button
          type="button"
          className="v2-header__palette"
          onClick={onPalette}
          aria-label="Open command palette"
        >
          <span className="v2-header__palette-icon">
            <Icon icon={Search} size="sm" />
          </span>
          <span className="v2-header__palette-label">Quick open</span>
          <KBD>⌘K</KBD>
        </button>

        <button
          type="button"
          className="v2-header__iconbtn"
          aria-label={hasNotifications ? "Notifications (unread)" : "Notifications"}
        >
          <Icon icon={Bell} size="md" />
          {hasNotifications && <span className="v2-header__notif-dot" aria-hidden="true" />}
        </button>

        <div className="v2-header__mode" role="group" aria-label="Daemon mode">
          {MODES.map((m) => (
            <button
              key={m}
              type="button"
              className="v2-header__mode-btn"
              data-active={mode === m}
              onClick={() => onModeChange?.(m)}
              aria-pressed={mode === m}
            >
              {m}
            </button>
          ))}
        </div>

        <button type="button" className="v2-header__avatar" aria-label="Profile">M</button>

        <span className="v2-header__legacy">
          <Button variant="ghost" size="sm" onClick={disableV2}>
            ← Legacy UI
          </Button>
        </span>
      </div>
    </header>
  );
}

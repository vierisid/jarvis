import React, { useEffect, useRef } from "react";
import {
  Bell,
  Check,
  ChevronRight,
  MessageSquare,
  ShieldAlert,
  AlertTriangle,
  type LucideIcon,
} from "lucide-react";
import { Icon } from "../ui";
import type { NotificationItem, NotificationKind } from "../../hooks/useNotificationCenter";
import { useI18n } from "../i18n/I18nProvider";
import type { DashboardLocale, MessageKey } from "../i18n/translations";
import "./NotificationDrawer.css";

export interface NotificationDrawerProps {
  open: boolean;
  items: NotificationItem[];
  onClose: () => void;
  onMarkAllRead: () => void;
  /**
   * Called when the user picks a notification. The shell is expected to:
   *  (1) mark it read, and
   *  (2) bring the corresponding thread item into view (and optionally close
   *      any open Room overlay so the thread is visible).
   */
  onPick: (id: string) => void;
}

const KIND_LABEL: Record<NotificationKind, MessageKey> = {
  approval: "notifications.approval",
  clarifier: "notifications.clarify",
  "repeat-back": "notifications.confirm",
  system: "notifications.system",
};

const KIND_ICON: Record<NotificationKind, LucideIcon> = {
  approval: ShieldAlert,
  clarifier: MessageSquare,
  "repeat-back": MessageSquare,
  system: AlertTriangle,
};

export function NotificationDrawer({
  open,
  items,
  onClose,
  onMarkAllRead,
  onPick,
}: NotificationDrawerProps) {
  const { locale, t } = useI18n();
  const rootRef = useRef<HTMLDivElement>(null);

  // Esc closes; click-outside closes. Both attached only while open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    const onPointer = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target || !rootRef.current) return;
      if (rootRef.current.contains(target)) return;
      // Don't auto-close when the click hits the bell — the bell's own
      // toggle will handle it. Tagging the bell with [data-notif-toggle]
      // keeps this check loose-coupled (no ref wiring).
      const toggle = (target as HTMLElement).closest?.("[data-notif-toggle]");
      if (toggle) return;
      onClose();
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onPointer, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onPointer, true);
    };
  }, [open, onClose]);

  // Move focus into the drawer on open so keyboard users land here.
  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => {
      const first = rootRef.current?.querySelector<HTMLElement>(
        "[data-notif-row], .v2-notif-drawer__markall",
      );
      first?.focus();
    }, 0);
    return () => window.clearTimeout(t);
  }, [open]);

  if (!open) return null;

  const unreadCount = items.reduce((n, item) => (item.unread ? n + 1 : n), 0);

  return (
    <div
      ref={rootRef}
      className="v2-notif-drawer"
      role="dialog"
      aria-label={t("notifications.title")}
      aria-modal="false"
    >
      <div className="v2-notif-drawer__head">
        <span className="v2-notif-drawer__title">{t("notifications.title")}</span>
        <button
          type="button"
          className="v2-notif-drawer__markall"
          onClick={onMarkAllRead}
          disabled={unreadCount === 0}
          aria-label={t("notifications.markAll")}
        >
          <Icon icon={Check} size="sm" />
          {t("notifications.markAll")}
        </button>
      </div>

      {items.length === 0 ? (
        <div className="v2-notif-drawer__empty">
          <Icon icon={Bell} size="md" />
          <p>{t("notifications.empty")}</p>
          <p className="v2-notif-drawer__empty-hint">
            {t("notifications.emptyHint")}
          </p>
        </div>
      ) : (
        <ul className="v2-notif-drawer__list" role="list">
          {items.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                data-notif-row
                data-tone={item.tone}
                data-unread={item.unread}
                className="v2-notif-drawer__row"
                onClick={() => onPick(item.id)}
              >
                <span className="v2-notif-drawer__row-icon" aria-hidden="true">
                  <Icon icon={KIND_ICON[item.kind]} size="sm" />
                </span>
                <span className="v2-notif-drawer__row-body">
                  <span className="v2-notif-drawer__row-meta">
                    <span className="v2-notif-drawer__row-kind">
                      {t(KIND_LABEL[item.kind])}
                    </span>
                    <span className="v2-notif-drawer__row-time">
                      {formatRelative(item.timestamp, locale, t)}
                    </span>
                  </span>
                  <span className="v2-notif-drawer__row-title">{item.title}</span>
                  {item.text && (
                    <span className="v2-notif-drawer__row-text">{item.text}</span>
                  )}
                </span>
                <span className="v2-notif-drawer__row-cta" aria-hidden="true">
                  <Icon icon={ChevronRight} size="sm" />
                </span>
                {item.unread && <span className="v2-notif-drawer__row-dot" aria-hidden="true" />}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * "5m ago", "2h ago", "yesterday". Falls back to a date string after a week
 * so the drawer doesn't grow ambiguous "weeks ago" labels.
 */
function formatRelative(
  ts: number,
  locale: DashboardLocale,
  t: (key: MessageKey, values?: Record<string, string | number>) => string,
): string {
  const now = Date.now();
  const diff = now - ts;
  if (diff < 0) return t("notifications.justNow");
  const sec = Math.floor(diff / 1000);
  if (sec < 45) return t("notifications.justNow");
  const min = Math.floor(sec / 60);
  if (min < 60) return t("notifications.minutesAgo", { count: min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return t("notifications.hoursAgo", { count: hr });
  const day = Math.floor(hr / 24);
  if (day === 1) return t("notifications.yesterday");
  if (day < 7) return t("notifications.daysAgo", { count: day });
  return new Date(ts).toLocaleDateString(locale);
}

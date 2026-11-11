import { useCallback, useEffect, useRef, useState } from "react";
import type { NotificationItem } from "../../hooks/useNotificationCenter";
import { dashboardToastNotice } from "../navigation/notifications";

const TOASTED_KEY = "jarvis:notif-toasted";
const TOASTED_LIMIT = 200;
/** How long the reminder stays on screen if nobody acts on it. */
export const TOAST_MS = 8000;

export function loadToasted(): Set<string> {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(TOASTED_KEY) ?? "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : []);
  } catch { return new Set(); }
}
function saveToasted(ids: Set<string>): void {
  try { window.localStorage.setItem(TOASTED_KEY, JSON.stringify([...ids].slice(-TOASTED_LIMIT))); }
  catch { /* the toast just shows again on the next visit */ }
}

/**
 * The reminder toast: each new unread reminder is announced once, for a few seconds, then it is
 * only in the Needs you list. Showing it, timing out or opening the list never marks it read;
 * Dismiss does, as it did before (the caller's `onDismiss`).
 */
export function useReminderToast(items: readonly NotificationItem[]) {
  const [notice, setNotice] = useState<NotificationItem | null>(null);
  const toasted = useRef<Set<string> | null>(null);
  toasted.current ??= loadToasted();
  const next = dashboardToastNotice(items.filter(item => !toasted.current!.has(item.id)));
  useEffect(() => {
    if (!next || notice) return;
    toasted.current!.add(next.id);
    saveToasted(toasted.current!);
    setNotice(next);
  }, [next?.id, notice]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [notice]);
  const hide = useCallback(() => setNotice(null), []);
  return { notice, hide };
}

export function ReminderToast({ notice, onView, onDismiss }: { notice: NotificationItem; onView(): void; onDismiss(): void }) {
  return <aside className="brief-root brief-host-toast" role="status" aria-label="New Jarvis notification">
    <strong>{notice.title}</strong><p>{notice.text}</p>
    <div className="brief-host-toast-actions"><button onClick={onView}>View notifications</button><button onClick={onDismiss}>Dismiss</button></div>
  </aside>;
}

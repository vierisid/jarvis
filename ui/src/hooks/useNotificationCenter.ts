import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  PendingApproval,
  PendingClarifier,
  PendingRepeatBack,
  SystemNotice,
} from "./useWebSocket";

/**
 * Single shape for everything the notification bell surfaces. The drawer
 * doesn't need to know whether a row started life as an approval, a
 * clarifier, or a sidecar warning — it renders by `kind` and dispatches
 * actions by `id` (which always maps back to a thread item or a daemon
 * resource).
 */
export type NotificationKind =
  | "approval"
  | "clarifier"
  | "repeat-back"
  | "system";

export type NotificationItem = {
  id: string;
  kind: NotificationKind;
  /** Short headline rendered as the row title. */
  title: string;
  /** Secondary text under the title — usually intent / transcript / reason. */
  text: string;
  /** Source timestamp used for sorting + the relative-time label. */
  timestamp: number;
  /** Tone used to colorize the row icon and unread dot. */
  tone: "ok" | "neutral" | "warn" | "accent";
  /** True when the row hasn't been opened/marked-read yet. */
  unread: boolean;
};

export interface NotificationCenterInput {
  approvals: PendingApproval[];
  clarifiers: PendingClarifier[];
  repeatBacks: PendingRepeatBack[];
  notices: SystemNotice[];
}

const STORAGE_KEY = "jarvis:notif-read";
/** Cap localStorage growth — once an id falls off the live streams it can
 *  never be re-shown anyway, so we don't need to remember it forever. */
const READ_SET_LIMIT = 500;

function loadReadSet(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((x): x is string => typeof x === "string"));
  } catch {
    return new Set();
  }
}

function saveReadSet(set: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    const arr = Array.from(set);
    const trimmed = arr.length > READ_SET_LIMIT ? arr.slice(-READ_SET_LIMIT) : arr;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    /* quota / privacy mode — silent */
  }
}

/**
 * Centralized notification feed for the header bell. Unions the four
 * "needs your attention" streams into a single chronological list and
 * tracks read/unread per id in localStorage so it survives reload.
 *
 * The hook does not own any of the underlying state — it derives from
 * `useLiveThread` outputs. That keeps a single source of truth: when a
 * clarifier resolves and drops out of `useWebSocket.clarifiers`, it
 * disappears from the bell automatically too.
 */
export function useNotificationCenter({
  approvals,
  clarifiers,
  repeatBacks,
  notices,
}: NotificationCenterInput) {
  const [readSet, setReadSet] = useState<Set<string>>(() => loadReadSet());

  // Persist any change to the read set. Keeping this as an effect (not
  // inside markRead) means a future caller that mutates readSet via
  // setReadSet directly still gets the persistence for free.
  useEffect(() => {
    saveReadSet(readSet);
  }, [readSet]);

  // Cross-tab sync: if another dashboard tab marks something read, mirror it.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return;
      setReadSet(loadReadSet());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const items = useMemo<NotificationItem[]>(() => {
    const out: NotificationItem[] = [];

    for (const a of approvals) {
      out.push({
        id: a.id,
        kind: "approval",
        title: a.intent || a.toolName,
        text: a.reason || a.category,
        timestamp: a.timestamp,
        tone: a.impact === "destructive" ? "accent" : a.impact === "external" ? "warn" : "neutral",
        unread: !readSet.has(a.id),
      });
    }

    for (const c of clarifiers) {
      out.push({
        id: c.id,
        kind: "clarifier",
        title: c.primary.label,
        text: c.transcript,
        timestamp: c.timestamp,
        tone: "warn",
        unread: !readSet.has(c.id),
      });
    }

    for (const r of repeatBacks) {
      out.push({
        id: r.id,
        kind: "repeat-back",
        title: "Confirm what I heard",
        text: r.transcript,
        timestamp: r.timestamp,
        tone: "warn",
        unread: !readSet.has(r.id),
      });
    }

    for (const n of notices) {
      out.push({
        id: n.id,
        kind: "system",
        title: n.title,
        text: n.text,
        // SystemNotice has no timestamp; treat as "right now" so it sorts
        // to the top until the user reads it.
        timestamp: Date.now(),
        tone: n.level === "warning" ? "warn" : "neutral",
        unread: !readSet.has(n.id),
      });
    }

    out.sort((a, b) => {
      // Unread first, then newest first within each group. The unread-first
      // grouping matters more than strict chronology — the bell is for
      // pending action, not a log.
      if (a.unread !== b.unread) return a.unread ? -1 : 1;
      return b.timestamp - a.timestamp;
    });

    return out;
  }, [approvals, clarifiers, repeatBacks, notices, readSet]);

  const unreadCount = useMemo(
    () => items.reduce((n, item) => (item.unread ? n + 1 : n), 0),
    [items],
  );

  const markRead = useCallback((id: string) => {
    setReadSet((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  const markAllRead = useCallback(() => {
    setReadSet((prev) => {
      // Only add ids that exist in the current items list — avoids
      // accumulating dead ids in localStorage.
      const live = new Set<string>();
      for (const item of items) {
        live.add(item.id);
        prev.forEach((existing) => live.add(existing));
      }
      return live;
    });
  }, [items]);

  return { items, unreadCount, markRead, markAllRead };
}

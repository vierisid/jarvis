import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLiveData } from "../../shell/LiveDataContext";

const POLL_INTERVAL_MS = 8000;

export type CalendarEventType = "commitment" | "content";

export interface CalendarEvent {
  id: string;
  type: CalendarEventType;
  title: string;
  timestamp: number;
  status: string;
  priority?: string;
  content_type?: string;
  stage?: string;
  assigned_to?: string;
  has_due_date?: boolean;
}

export type CalendarPriority = "critical" | "high" | "normal" | "low";

interface ActionResult {
  ok: boolean;
  message: string;
}

/**
 * Calendar Room hook — loads events for the visible week and exposes
 * write actions used by both the UI quick-create and the
 * `schedule_event` voice action. Polls every 8s; live additions also
 * arrive via `taskEvents` from LiveDataContext (drives a refresh on
 * any task creation/update).
 *
 * Week navigation lives here so the hook owns the visible range —
 * keeps refresh logic in one place.
 */
export function useCalendarData() {
  const live = useLiveData();
  const [weekStart, setWeekStart] = useState<number>(() => startOfWeek(Date.now()));
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const inFlightRef = useRef(false);
  const lastTaskEventCountRef = useRef(0);

  const refresh = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const rangeStart = weekStart;
      const rangeEnd = weekStart + 7 * 86_400_000;
      const resp = await fetch(`/api/calendar?range_start=${rangeStart}&range_end=${rangeEnd}`);
      if (resp.ok) {
        const data = (await resp.json()) as CalendarEvent[];
        setEvents(Array.isArray(data) ? data : []);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load calendar");
    } finally {
      inFlightRef.current = false;
      setLoading(false);
    }
  }, [weekStart]);

  // Initial + interval poll, paused while tab hidden.
  useEffect(() => {
    refresh();
    const id = window.setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      refresh();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [refresh]);

  // Live tail: refresh on any new task event so user-driven creates show
  // up immediately without waiting for the 8s poll. Cheap because the
  // refresh hits a single REST endpoint with a bounded time range.
  useEffect(() => {
    if (live.taskEvents.length !== lastTaskEventCountRef.current) {
      lastTaskEventCountRef.current = live.taskEvents.length;
      refresh();
    }
  }, [live.taskEvents.length, refresh]);

  // Group events by day-of-week index (0-6 from weekStart).
  const eventsByDay = useMemo(() => {
    const map = new Map<number, CalendarEvent[]>();
    for (let i = 0; i < 7; i++) map.set(i, []);
    for (const e of events) {
      const dayIdx = Math.floor((e.timestamp - weekStart) / 86_400_000);
      if (dayIdx >= 0 && dayIdx < 7) {
        map.get(dayIdx)!.push(e);
      }
    }
    return map;
  }, [events, weekStart]);

  const goToWeek = useCallback((offset: number) => {
    setWeekStart((prev) => prev + offset * 7 * 86_400_000);
  }, []);

  const goToToday = useCallback(() => {
    setWeekStart(startOfWeek(Date.now()));
  }, []);

  /** Fuzzy lookup by title for voice select_event / schedule_event collision check. */
  const findByTitle = useCallback(
    (title: string): CalendarEvent | null => {
      const q = title.trim().toLowerCase();
      if (!q) return null;
      const exact = events.find((e) => e.title.toLowerCase() === q);
      if (exact) return exact;
      return events.find((e) => e.title.toLowerCase().includes(q)) ?? null;
    },
    [events],
  );

  /**
   * Voice + UI write path: schedule a new event by creating a commitment
   * in the vault. Reuses the existing POST /api/vault/commitments — the
   * Calendar Room is just a different read view over the same data.
   */
  const addEvent = useCallback(
    async (input: {
      title: string;
      whenMs?: number;
      priority?: CalendarPriority;
      assigned_to?: string;
      context?: string;
    }): Promise<ActionResult> => {
      try {
        const resp = await fetch("/api/vault/commitments", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            what: input.title,
            when_due: input.whenMs,
            priority: input.priority,
            assigned_to: input.assigned_to,
            context: input.context,
          }),
        });
        if (!resp.ok) throw new Error(await resp.text() || `HTTP ${resp.status}`);
        refresh();
        return {
          ok: true,
          message: input.whenMs
            ? `Scheduled "${input.title}" for ${formatDateTime(input.whenMs)}.`
            : `Added "${input.title}" to your task list.`,
        };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : "Failed" };
      }
    },
    [refresh],
  );

  return {
    weekStart,
    events,
    eventsByDay,
    loading,
    error,
    refresh,
    goToWeek,
    goToToday,
    findByTitle,
    addEvent,
  };
}

/* ─────────── helpers ─────────── */

/** Monday 00:00 of the week containing the given timestamp. */
function startOfWeek(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  // getDay(): Sunday=0, Monday=1 — shift so Monday is the start.
  const dow = d.getDay();
  const offset = dow === 0 ? -6 : 1 - dow;
  d.setDate(d.getDate() + offset);
  return d.getTime();
}

function formatDateTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

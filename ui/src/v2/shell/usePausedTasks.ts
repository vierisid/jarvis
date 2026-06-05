import { useCallback, useEffect, useRef, useState } from "react";
import type { TaskEvent } from "../../hooks/useWebSocket";

/**
 * One row in the paused-tasks API response. Mirrors the shape returned by
 * `/api/tasks/paused` (see api-routes.ts).
 */
export interface PausedTaskSummary {
  id: string;
  template: string;
  intent: string;
  question: string;
  started_at: number;
  updated_at: number;
}

/**
 * Subscribe to the list of conv-tier tasks that are paused awaiting user
 * clarification. The list is fetched on mount (so daemon-restart-recovered
 * tasks appear immediately) and refetched whenever a relevant task_event
 * fires - any started/completed/failed/cancelled event can change the set.
 *
 * Pass the live `taskEvents` array from useLiveData() as `events` so the
 * hook stays in sync without opening its own WS connection. The hook tracks
 * in-flight requests with a counter so rapid event bursts can't let a stale
 * response overwrite a newer one.
 */
export function usePausedTasks(events: TaskEvent[]): {
  tasks: PausedTaskSummary[];
  refresh: () => void;
} {
  const [tasks, setTasks] = useState<PausedTaskSummary[]>([]);
  const inFlightRef = useRef(0);

  const refresh = useCallback(async () => {
    const reqId = ++inFlightRef.current;
    try {
      const r = await fetch("/api/tasks/paused");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as { tasks: PausedTaskSummary[] };
      // Drop the response if a newer request was started while this one was
      // in flight - otherwise a slow first request could overwrite the
      // fresher state from a later event.
      if (reqId !== inFlightRef.current) return;
      setTasks(data.tasks ?? []);
    } catch (err) {
      // Best-effort: if the endpoint isn't reachable we just show no tasks.
      // The banner stays hidden rather than display a confusing error.
      console.warn("[usePausedTasks] fetch failed:", err);
    }
  }, []);

  // Initial fetch (covers the daemon-restart-recovery surfacing path).
  useEffect(() => { refresh(); }, [refresh]);

  // Refetch whenever a task event arrives - paused tasks can appear (task
  // pauses mid-conversation) or disappear (task resumes / completes /
  // cancels). useWebSocket only produces a new events array reference when
  // an event is appended, so this won't fire on unrelated renders.
  useEffect(() => {
    if (events.length === 0) return;
    refresh();
  }, [events, refresh]);

  return { tasks, refresh };
}

import { useCallback, useEffect, useState } from "react";
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
 * hook stays in sync without opening its own WS connection.
 */
export function usePausedTasks(events: TaskEvent[]): {
  tasks: PausedTaskSummary[];
  loading: boolean;
  refresh: () => void;
} {
  const [tasks, setTasks] = useState<PausedTaskSummary[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/tasks/paused");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as { tasks: PausedTaskSummary[] };
      setTasks(data.tasks ?? []);
    } catch (err) {
      // Best-effort: if the endpoint isn't reachable we just show no tasks.
      // The banner stays hidden rather than display a confusing error.
      console.warn("[usePausedTasks] fetch failed:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial fetch (covers the daemon-restart-recovery surfacing path).
  useEffect(() => { refresh(); }, [refresh]);

  // Refetch whenever a task event arrives - paused tasks can appear (task
  // pauses mid-conversation) or disappear (task resumes / completes /
  // cancels). We key on the events array reference so React only reruns on
  // a new event, not on every render.
  useEffect(() => {
    if (events.length === 0) return;
    refresh();
  }, [events, refresh]);

  return { tasks, loading, refresh };
}

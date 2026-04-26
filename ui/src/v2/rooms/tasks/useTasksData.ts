import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLiveData } from "../../shell/LiveDataContext";

const POLL_INTERVAL_MS = 8000;

export type TaskStatus = "pending" | "active" | "completed" | "failed" | "escalated";
export type TaskPriority = "low" | "normal" | "high" | "critical";

export const TASK_STATUSES: ReadonlyArray<TaskStatus> = [
  "pending", "active", "completed", "failed", "escalated",
];

export const TASK_PRIORITIES: ReadonlyArray<TaskPriority> = [
  "low", "normal", "high", "critical",
];

export interface Task {
  id: string;
  what: string;
  when_due: number | null;
  context: string | null;
  priority: TaskPriority;
  status: TaskStatus;
  assigned_to: string | null;
  created_at: number;
  completed_at: number | null;
  result: string | null;
  sort_order: number;
}

interface ActionResult {
  ok: boolean;
  message: string;
}

/**
 * Tasks Room hook — loads commitments from /api/vault/commitments,
 * groups by status for kanban rendering, and exposes write actions
 * that map to PATCH on the same row. Live updates piggyback on
 * `taskEvents` from LiveDataContext (already lifted in Phase 6.2-B)
 * so user-driven creates from elsewhere (Calendar, voice, chat) show
 * up immediately without waiting for the 8s poll.
 *
 * Reuses POST /api/vault/commitments — same endpoint Calendar uses
 * for `schedule_event`. No new backend.
 */
export function useTasksData() {
  const live = useLiveData();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const inFlightRef = useRef(false);
  const lastTaskEventCountRef = useRef(0);

  const refresh = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const resp = await fetch("/api/vault/commitments");
      if (resp.ok) {
        const data = (await resp.json()) as Task[];
        setTasks(Array.isArray(data) ? data : []);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load tasks");
    } finally {
      inFlightRef.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = window.setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      refresh();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [refresh]);

  // Live tail — same pattern as Calendar.
  useEffect(() => {
    if (live.taskEvents.length !== lastTaskEventCountRef.current) {
      lastTaskEventCountRef.current = live.taskEvents.length;
      refresh();
    }
  }, [live.taskEvents.length, refresh]);

  const tasksByStatus = useMemo(() => {
    const map = new Map<TaskStatus, Task[]>();
    for (const s of TASK_STATUSES) map.set(s, []);
    for (const t of tasks) map.get(t.status)?.push(t);
    // Within each column: by priority desc, then due-date asc, then created asc.
    const priorityRank: Record<TaskPriority, number> = { critical: 0, high: 1, normal: 2, low: 3 };
    for (const list of map.values()) {
      list.sort((a, b) => {
        const p = priorityRank[a.priority] - priorityRank[b.priority];
        if (p !== 0) return p;
        const da = a.when_due ?? Number.MAX_SAFE_INTEGER;
        const db = b.when_due ?? Number.MAX_SAFE_INTEGER;
        if (da !== db) return da - db;
        return a.sort_order - b.sort_order;
      });
    }
    return map;
  }, [tasks]);

  const stats = useMemo(() => {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const startMs = startOfDay.getTime();
    const now = Date.now();
    return {
      total: tasks.length,
      active: tasks.filter((t) => t.status === "active" || t.status === "pending").length,
      completedToday: tasks.filter(
        (t) => t.status === "completed" && t.completed_at && t.completed_at >= startMs,
      ).length,
      overdue: tasks.filter(
        (t) =>
          (t.status === "pending" || t.status === "active") &&
          t.when_due !== null &&
          t.when_due < now,
      ).length,
    };
  }, [tasks]);

  const findByName = useCallback(
    (name: string): Task | null => {
      const q = name.trim().toLowerCase();
      if (!q) return null;
      const exact = tasks.find((t) => t.what.toLowerCase() === q);
      if (exact) return exact;
      return tasks.find((t) => t.what.toLowerCase().includes(q)) ?? null;
    },
    [tasks],
  );

  const createTask = useCallback(
    async (input: {
      what: string;
      when_due?: number;
      priority?: TaskPriority;
      assigned_to?: string;
      context?: string;
    }): Promise<{ ok: true; task: Task } | { ok: false; message: string }> => {
      try {
        const resp = await fetch("/api/vault/commitments", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            what: input.what,
            when_due: input.when_due,
            priority: input.priority,
            assigned_to: input.assigned_to,
            context: input.context,
          }),
        });
        if (!resp.ok) throw new Error(await resp.text() || `HTTP ${resp.status}`);
        const task = (await resp.json()) as Task;
        refresh();
        return { ok: true, task };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : "Failed" };
      }
    },
    [refresh],
  );

  const updateStatus = useCallback(
    async (id: string, status: TaskStatus, result?: string): Promise<ActionResult> => {
      try {
        const body: Record<string, unknown> = { status };
        if (result !== undefined) body.result = result;
        const resp = await fetch(`/api/vault/commitments/${encodeURIComponent(id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        refresh();
        return { ok: true, message: `Task ${status}.` };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : "Failed" };
      }
    },
    [refresh],
  );

  const updatePriority = useCallback(
    async (id: string, priority: TaskPriority): Promise<ActionResult> => {
      try {
        const resp = await fetch(`/api/vault/commitments/${encodeURIComponent(id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ priority }),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        refresh();
        return { ok: true, message: `Priority set to ${priority}.` };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : "Failed" };
      }
    },
    [refresh],
  );

  const reassign = useCallback(
    async (id: string, assigned_to: string | null): Promise<ActionResult> => {
      try {
        const resp = await fetch(`/api/vault/commitments/${encodeURIComponent(id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ assigned_to }),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        refresh();
        return {
          ok: true,
          message: assigned_to
            ? `Reassigned to ${assigned_to}.`
            : `Unassigned.`,
        };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : "Failed" };
      }
    },
    [refresh],
  );

  return {
    tasks,
    tasksByStatus,
    stats,
    loading,
    error,
    refresh,
    findByName,
    createTask,
    updateStatus,
    updatePriority,
    reassign,
  };
}

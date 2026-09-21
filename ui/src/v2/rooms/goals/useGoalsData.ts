import { useCallback, useMemo } from "react";

import { readArray, readObject, useRemoteData } from "../../hooks/useRemoteData";

const POLL_INTERVAL_MS = 8000;

export type GoalLevel = "objective" | "key_result" | "milestone" | "task" | "daily_action";
export type GoalStatus = "draft" | "active" | "paused" | "completed" | "failed" | "killed";
export type GoalHealth = "on_track" | "at_risk" | "behind" | "critical";
export type TimeHorizon = "life" | "yearly" | "quarterly" | "monthly" | "weekly" | "daily";

export const GOAL_LEVELS: ReadonlyArray<GoalLevel> = [
  "objective", "key_result", "milestone", "task", "daily_action",
];

export const GOAL_STATUSES: ReadonlyArray<GoalStatus> = [
  "draft", "active", "paused", "completed", "failed", "killed",
];

export const GOAL_HEALTHS: ReadonlyArray<GoalHealth> = [
  "on_track", "at_risk", "behind", "critical",
];

export interface Goal {
  id: string;
  parent_id: string | null;
  level: GoalLevel;
  title: string;
  description: string;
  success_criteria: string;
  time_horizon: TimeHorizon;
  score: number;
  score_reason: string | null;
  status: GoalStatus;
  health: GoalHealth;
  deadline: number | null;
  started_at: number | null;
  estimated_hours: number | null;
  actual_hours: number;
  authority_level: number;
  tags: string[];
  dependencies: string[];
  sort_order: number;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

export interface GoalsMetrics {
  total: number;
  active: number;
  completed: number;
  failed: number;
  killed: number;
  avg_score: number;
  on_track: number;
  at_risk: number;
  behind: number;
  critical: number;
  overdue: number;
}

interface ActionResult {
  ok: boolean;
  message: string;
}

/**
 * Goals Room hook — loads the full goal list, metrics, and overdue
 * subset in parallel; exposes write actions for create/score/status/
 * health updates. Polls every 8s; child relationships derived locally
 * via parent_id rather than refetching `/api/goals/:id/children` per
 * goal.
 */
export function useGoalsData() {
  const goalData = useRemoteData("/api/goals?limit=200", readArray<Goal>, POLL_INTERVAL_MS);
  const metricData = useRemoteData("/api/goals/metrics", readMetrics, POLL_INTERVAL_MS);
  const overdueData = useRemoteData("/api/goals/overdue", readArray<Goal>, POLL_INTERVAL_MS);
  const goals = goalData.data ?? EMPTY_GOALS;
  const metrics = metricData.data;
  const overdue = overdueData.data ?? EMPTY_GOALS;
  const sections = { goals: goalData, metrics: metricData, overdue: overdueData };
  const loading = Object.values(sections).some(s => s.availability === "loading");
  const error = Object.values(sections).map(s => s.error).filter(Boolean).join(" ") || null;
  const refresh = useCallback(async () => {
    await Promise.all([goalData.refresh(), metricData.refresh(), overdueData.refresh()]);
  }, [goalData.refresh, metricData.refresh, overdueData.refresh]);

  /** Roots = top-level objectives (no parent). */
  const roots = useMemo(
    () => goals.filter((g) => g.parent_id === null).sort((a, b) => a.sort_order - b.sort_order),
    [goals],
  );

  /** parent_id → Goal[]; used by the constellation tree walker. */
  const childrenByParent = useMemo(() => {
    const map = new Map<string, Goal[]>();
    for (const g of goals) {
      if (g.parent_id) {
        const arr = map.get(g.parent_id);
        if (arr) arr.push(g);
        else map.set(g.parent_id, [g]);
      }
    }
    for (const arr of map.values()) arr.sort((a, b) => a.sort_order - b.sort_order);
    return map;
  }, [goals]);

  const findByName = useCallback(
    (name: string): Goal | null => {
      const q = name.trim().toLowerCase();
      if (!q) return null;
      const exact = goals.find((g) => g.title.toLowerCase() === q);
      if (exact) return exact;
      return goals.find((g) => g.title.toLowerCase().includes(q)) ?? null;
    },
    [goals],
  );

  const createQuick = useCallback(
    async (input: {
      title: string;
      level?: GoalLevel;
      parent_id?: string;
      deadline?: number;
      description?: string;
    }): Promise<{ ok: true; goal: Goal } | { ok: false; message: string }> => {
      try {
        const resp = await fetch("/api/goals", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mode: "quick",
            title: input.title,
            level: input.level ?? "task",
            parent_id: input.parent_id ?? null,
            deadline: input.deadline ?? null,
            description: input.description ?? "",
          }),
        });
        if (!resp.ok) throw new Error(await resp.text() || `HTTP ${resp.status}`);
        const goal = (await resp.json()) as Goal;
        refresh();
        return { ok: true, goal };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : "Failed" };
      }
    },
    [refresh],
  );

  const updateScore = useCallback(
    async (id: string, score: number, reason: string): Promise<ActionResult> => {
      try {
        const resp = await fetch(`/api/goals/${encodeURIComponent(id)}/score`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ score, reason, source: "dashboard" }),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        refresh();
        return { ok: true, message: `Score updated to ${(score * 100).toFixed(0)}%.` };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : "Failed" };
      }
    },
    [refresh],
  );

  const updateStatus = useCallback(
    async (id: string, status: GoalStatus): Promise<ActionResult> => {
      try {
        const resp = await fetch(`/api/goals/${encodeURIComponent(id)}/status`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status }),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        refresh();
        return { ok: true, message: `Status set to ${status}.` };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : "Failed" };
      }
    },
    [refresh],
  );

  const updateHealth = useCallback(
    async (id: string, health: GoalHealth): Promise<ActionResult> => {
      try {
        const resp = await fetch(`/api/goals/${encodeURIComponent(id)}/health`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ health }),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        refresh();
        return { ok: true, message: `Health set to ${health.replace(/_/g, " ")}.` };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : "Failed" };
      }
    },
    [refresh],
  );

  return {
    sections,
    goals,
    roots,
    childrenByParent,
    metrics,
    overdue,
    loading,
    error,
    refresh,
    findByName,
    createQuick,
    updateScore,
    updateStatus,
    updateHealth,
  };
}

const EMPTY_GOALS: Goal[] = [];
function readMetrics(value: unknown): GoalsMetrics {
  const metrics = readObject<GoalsMetrics>(value);
  const fields: (keyof GoalsMetrics)[] = ["total", "active", "completed", "failed", "killed", "avg_score", "on_track", "at_risk", "behind", "critical", "overdue"];
  if (fields.some(key => typeof metrics[key] !== "number" || !Number.isFinite(metrics[key]))) throw new Error("Unexpected metrics.");
  return metrics;
}

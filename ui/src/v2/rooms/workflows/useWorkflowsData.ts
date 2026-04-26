import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLiveData } from "../../shell/LiveDataContext";

const POLL_INTERVAL_MS = 5000;

export interface Workflow {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  tags: string[];
  current_version: number;
  execution_count: number;
  last_executed_at: number | null;
  last_success_at: number | null;
  last_failure_at: number | null;
  created_at: number;
  updated_at: number;
}

export type WorkflowFilter = "all" | "active" | "paused";

export interface WorkflowsStats {
  total: number;
  active: number;
  paused: number;
  executions: number;
  /** Live-tail count: workflow events seen since dashboard open. */
  recentEvents: number;
}

interface ActionResult {
  ok: boolean;
  message: string;
}

export function useWorkflowsData() {
  const live = useLiveData();
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const inFlightRef = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const resp = await fetch("/api/workflows");
      if (resp.ok) {
        const data = (await resp.json()) as Workflow[];
        setWorkflows(Array.isArray(data) ? data : []);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load workflows");
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

  const stats = useMemo<WorkflowsStats>(() => {
    const total = workflows.length;
    const active = workflows.filter((w) => w.enabled).length;
    const paused = total - active;
    const executions = workflows.reduce((sum, w) => sum + w.execution_count, 0);
    return {
      total,
      active,
      paused,
      executions,
      // No taskEvents proxy for workflow_event yet — live array would need
      // a separate WS hook. Defer; recent events shown elsewhere via Logs.
      recentEvents: 0,
    };
  }, [workflows]);
  // Suppress unused `live` import lint when we don't yet read from it.
  void live;

  const setEnabled = useCallback(
    async (id: string, enabled: boolean): Promise<ActionResult> => {
      try {
        const resp = await fetch(`/api/workflows/${encodeURIComponent(id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled }),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        refresh();
        return { ok: true, message: enabled ? "Workflow enabled." : "Workflow paused." };
      } catch (err) {
        return {
          ok: false,
          message: err instanceof Error ? err.message : "Failed to update workflow.",
        };
      }
    },
    [refresh],
  );

  const execute = useCallback(async (id: string): Promise<ActionResult> => {
    try {
      const resp = await fetch(`/api/workflows/${encodeURIComponent(id)}/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return { ok: true, message: "Run started." };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : "Failed to start run.",
      };
    }
  }, []);

  const create = useCallback(
    async (name: string, description = ""): Promise<{ ok: true; workflow: Workflow } | { ok: false; message: string }> => {
      try {
        const resp = await fetch("/api/workflows", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name,
            description,
            definition: {
              nodes: [
                {
                  id: "trigger-1",
                  type: "trigger.manual",
                  label: "Manual Trigger",
                  position: { x: 100, y: 200 },
                  config: {},
                },
              ],
              edges: [],
              settings: {
                maxRetries: 3,
                retryDelayMs: 5000,
                timeoutMs: 300000,
                parallelism: "parallel",
                onError: "stop",
              },
            },
          }),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const wf = (await resp.json()) as Workflow;
        refresh();
        return { ok: true, workflow: wf };
      } catch (err) {
        return {
          ok: false,
          message: err instanceof Error ? err.message : "Failed to create workflow.",
        };
      }
    },
    [refresh],
  );

  /**
   * Fuzzy lookup for voice "select X" / "run X" / "pause X" — exact name match
   * preferred, then case-insensitive includes. Returns null when no candidate
   * is unambiguous enough to act on.
   */
  const findByName = useCallback(
    (name: string): Workflow | null => {
      const q = name.trim().toLowerCase();
      if (!q) return null;
      const exact = workflows.find((w) => w.name.toLowerCase() === q);
      if (exact) return exact;
      return workflows.find((w) => w.name.toLowerCase().includes(q)) ?? null;
    },
    [workflows],
  );

  return {
    workflows,
    stats,
    error,
    loading,
    refresh,
    setEnabled,
    execute,
    create,
    findByName,
  };
}

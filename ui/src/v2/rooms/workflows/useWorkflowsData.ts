import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const POLL_INTERVAL_MS = 8000;

export type FlowStatus = "ENABLED" | "DISABLED";
export type FlowRunStatus =
  | "QUEUED"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "PAUSED"
  | "TIMEOUT"
  | "INTERNAL_ERROR"
  | "QUOTA_EXCEEDED"
  | "STOPPED"
  | "MEMORY_LIMIT_EXCEEDED"
  | "SCHEDULE_FAILURE";

export interface Flow {
  id: string;
  externalId: string;
  projectId: string;
  status: FlowStatus;
  publishedVersionId: string | null;
  metadata: Record<string, unknown> | null;
  created: number;
  updated: number;
  /** Filled in by the hook from /workflows/:id (latestDraft.displayName). */
  displayName?: string;
}

export interface FlowRun {
  id: string;
  flowId: string;
  flowVersionId: string;
  status: FlowRunStatus;
  environment: "PRODUCTION" | "TESTING";
  startTime: number | null;
  finishTime: number | null;
  stepsCount: number | null;
  steps: Record<string, unknown> | null;
  failedStep: { name: string; displayName: string } | null;
  triggeredBy: string | null;
  created: number;
  updated: number;
}

interface ActionResult {
  ok: boolean;
  message: string;
}

/**
 * Workflows room data hook.
 *
 * - Polls `/api/workflows` every 8s for the flow list.
 * - For each flow, fetches `/api/workflows/:id` once on first sight to fill
 *   in `displayName` (lives on the latest version, not the flow row). Names
 *   are cached client-side; re-fetched only if a flow's `updated` timestamp
 *   advances past the cached entry's.
 * - For the selected flow, polls `/api/workflows/:id/runs` every poll cycle.
 *
 * Write actions are non-optimistic: they wait for the server, then refresh
 * the relevant list. Errors surface via the returned `ActionResult`.
 */
export interface TriggerWarning {
  flowId: string;
  /**
   * Subscription kind from `TriggerManager.list()`. Kept loose (`string`)
   * because new kinds can land server-side without a UI release -- the UI
   * doesn't branch on kind, only displays warnings.
   */
  kind: string;
  warning: string;
}

export function useWorkflowsData() {
  const [flows, setFlows] = useState<Flow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Per-flow trigger warnings (e.g. engine ON_ENABLE half-failed, webhook
  // route partially registered). Populated alongside flows so the list view
  // can badge affected rows.
  const [triggerWarnings, setTriggerWarnings] = useState<Record<string, TriggerWarning>>({});

  // Per-flow run history. Keyed by flow id; only loaded for the selected flow.
  const [runs, setRuns] = useState<Record<string, FlowRun[]>>({});
  const [selectedFlowId, setSelectedFlowId] = useState<string | null>(null);

  const inFlightRef = useRef(false);
  // Cache: flowId -> { displayName, updatedAt } so we don't re-fetch on every poll.
  const nameCacheRef = useRef<Map<string, { displayName: string; updatedAt: number }>>(new Map());

  const refresh = useCallback(async (): Promise<void> => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const res = await fetch("/api/workflows");
      if (!res.ok) throw new Error(`GET /api/workflows -> ${res.status}`);
      const list = (await res.json()) as Flow[];
      setError(null);
      // Patch displayName from the cache (or queue a fetch for entries that
      // are missing or stale).
      const enriched: Flow[] = list.map((f) => {
        const cached = nameCacheRef.current.get(f.id);
        return cached ? { ...f, displayName: cached.displayName } : f;
      });
      setFlows(enriched);

      // Triggers feed in alongside the flow list. Errors are non-fatal
      // (workflows still render); we just skip the warning badges.
      // Awaited inline so `await refresh()` callers see the warnings settled
      // when refresh resolves -- avoids a stale-data window where the
      // selected flow's warning hasn't loaded yet.
      try {
        const tr = await fetch("/api/workflows/triggers");
        if (tr.ok) {
          const subs = (await tr.json()) as Array<TriggerWarning & { warning?: string }>;
          const map: Record<string, TriggerWarning> = {};
          for (const s of subs) {
            if (typeof s.warning === "string" && s.warning.length > 0) {
              map[s.flowId] = { flowId: s.flowId, kind: s.kind, warning: s.warning };
            }
          }
          setTriggerWarnings(map);
        }
      } catch {
        /* keep prior warnings, don't surface as a top-level error */
      }

      // Fetch missing or stale names without blocking the main render.
      const stale = list.filter((f) => {
        const c = nameCacheRef.current.get(f.id);
        return !c || c.updatedAt < f.updated;
      });
      if (stale.length > 0) {
        void Promise.all(
          stale.map(async (f) => {
            try {
              const detail = await fetch(`/api/workflows/${f.id}`);
              if (!detail.ok) return;
              const body = (await detail.json()) as {
                latestDraft?: { displayName?: string };
                published?: { displayName?: string } | null;
              };
              const name = body.latestDraft?.displayName ?? body.published?.displayName;
              if (typeof name === "string" && name.length > 0) {
                nameCacheRef.current.set(f.id, { displayName: name, updatedAt: f.updated });
                setFlows((prev) => prev.map((p) => (p.id === f.id ? { ...p, displayName: name } : p)));
              }
            } catch {
              /* best-effort; row falls back to id */
            }
          }),
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      inFlightRef.current = false;
      setLoading(false);
    }
  }, []);

  const refreshRuns = useCallback(async (flowId: string): Promise<void> => {
    try {
      const res = await fetch(`/api/workflows/${flowId}/runs?limit=50`);
      if (!res.ok) throw new Error(`GET /api/workflows/${flowId}/runs -> ${res.status}`);
      const list = (await res.json()) as FlowRun[];
      setRuns((prev) => ({ ...prev, [flowId]: list }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const runFlow = useCallback(async (flowId: string): Promise<ActionResult> => {
    try {
      const res = await fetch(`/api/workflows/${flowId}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ triggeredBy: "dashboard" }),
      });
      if (!res.ok) {
        const body = await safeJson(res);
        return { ok: false, message: body?.error ?? `run failed: ${res.status}` };
      }
      void refreshRuns(flowId);
      return { ok: true, message: "Run queued" };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }, [refreshRuns]);

  const setStatus = useCallback(async (flowId: string, status: FlowStatus): Promise<ActionResult> => {
    try {
      const res = await fetch(`/api/workflows/${flowId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) {
        const body = await safeJson(res);
        return { ok: false, message: body?.error ?? `update failed: ${res.status}` };
      }
      void refresh();
      return { ok: true, message: status === "ENABLED" ? "Flow enabled" : "Flow disabled" };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }, [refresh]);

  const publishFlow = useCallback(async (flowId: string): Promise<ActionResult> => {
    try {
      const res = await fetch(`/api/workflows/${flowId}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok) {
        const body = await safeJson(res);
        return { ok: false, message: body?.error ?? `publish failed: ${res.status}` };
      }
      void refresh();
      return { ok: true, message: "Published" };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }, [refresh]);

  const deleteFlow = useCallback(async (flowId: string): Promise<ActionResult> => {
    try {
      const res = await fetch(`/api/workflows/${flowId}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await safeJson(res);
        return { ok: false, message: body?.error ?? `delete failed: ${res.status}` };
      }
      nameCacheRef.current.delete(flowId);
      setRuns((prev) => {
        const next = { ...prev };
        delete next[flowId];
        return next;
      });
      void refresh();
      if (selectedFlowId === flowId) setSelectedFlowId(null);
      return { ok: true, message: "Deleted" };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }, [refresh, selectedFlowId]);

  /**
   * Create a fresh workflow. POSTs to `/api/workflows`, which creates the
   * flow row + a DRAFT version named `displayName`. Returns the new flow's
   * id on success so callers can open the editor on it immediately.
   *
   * `displayName` defaults to a human-readable placeholder; users rename
   * from inside the editor.
   */
  const createFlow = useCallback(
    async (displayName = "Untitled workflow"): Promise<ActionResult & { flowId?: string }> => {
      try {
        const res = await fetch("/api/workflows", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ displayName }),
        });
        if (!res.ok) {
          const body = await safeJson(res);
          return { ok: false, message: body?.error ?? `create failed: ${res.status}` };
        }
        const body = (await res.json()) as { flow: Flow; version: { id: string } };
        void refresh();
        return { ok: true, message: "Workflow created", flowId: body.flow.id };
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) };
      }
    },
    [refresh],
  );

  const cancelRun = useCallback(async (runId: string): Promise<ActionResult> => {
    try {
      const res = await fetch(`/api/workflow-runs/${runId}/cancel`, { method: "POST" });
      if (!res.ok) {
        const body = await safeJson(res);
        return { ok: false, message: body?.error ?? `cancel failed: ${res.status}` };
      }
      if (selectedFlowId) void refreshRuns(selectedFlowId);
      return { ok: true, message: "Run canceled" };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }, [refreshRuns, selectedFlowId]);

  // Initial load + poll loop.
  useEffect(() => {
    void refresh();
    const id = setInterval(() => {
      void refresh();
      if (selectedFlowId) void refreshRuns(selectedFlowId);
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [refresh, refreshRuns, selectedFlowId]);

  // When the selection changes, fetch its run history immediately.
  useEffect(() => {
    if (selectedFlowId) void refreshRuns(selectedFlowId);
  }, [selectedFlowId, refreshRuns]);

  const selectedFlow = useMemo(
    () => (selectedFlowId ? flows.find((f) => f.id === selectedFlowId) ?? null : null),
    [flows, selectedFlowId],
  );

  const selectedRuns = useMemo(
    () => (selectedFlowId ? runs[selectedFlowId] ?? [] : []),
    [runs, selectedFlowId],
  );

  // Editor state -- when set, the dashboard mounts the visual editor for this flow.
  const [editingFlowId, setEditingFlowId] = useState<string | null>(null);

  return {
    flows,
    loading,
    error,
    triggerWarnings,
    selectedFlowId,
    setSelectedFlowId,
    selectedFlow,
    selectedRuns,
    refresh,
    refreshRuns,
    runFlow,
    setStatus,
    publishFlow,
    deleteFlow,
    createFlow,
    cancelRun,
    editingFlowId,
    setEditingFlowId,
  };
}

async function safeJson(res: Response): Promise<{ error?: string } | null> {
  try {
    return (await res.json()) as { error?: string };
  } catch {
    return null;
  }
}

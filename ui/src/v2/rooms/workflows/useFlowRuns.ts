/**
 * Scoped runs hook for a single flow -- powers the editor's Run button and
 * the in-editor Runs panel.
 *
 * Why a separate hook (not `useWorkflowsData.refreshRuns`):
 *   - `useWorkflowsData` polls the entire workflows list every 8s plus the
 *     selected flow's runs. The editor doesn't need the full list and we
 *     want the *editor's* poll cadence to be aggressive (run feedback feels
 *     wrong at 8s) without bleeding that into the room-level list.
 *   - Polling here is adaptive: 2s while at least one run is non-terminal
 *     (QUEUED / RUNNING / PAUSED), 8s otherwise. Stops entirely while the
 *     browser tab is hidden so we don't burn cycles on a background flow.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { FlowRun, FlowRunStatus } from "./useWorkflowsData";

const TERMINAL_STATUSES = new Set<FlowRunStatus>([
  "SUCCEEDED",
  "FAILED",
  "STOPPED",
  "TIMEOUT",
  "INTERNAL_ERROR",
  "QUOTA_EXCEEDED",
  "MEMORY_LIMIT_EXCEEDED",
  "SCHEDULE_FAILURE",
]);

const ACTIVE_POLL_MS = 2000;
const IDLE_POLL_MS = 8000;

export interface RunActionResult {
  ok: boolean;
  message: string;
  runId?: string;
}

export interface FlowRunsState {
  runs: FlowRun[];
  loading: boolean;
  error: string | null;
  /** True between the user clicking Run and the server returning. */
  starting: boolean;
  refresh: () => Promise<void>;
  /** Queue a run for this flow. Returns the runId on success. */
  start: (payload?: Record<string, unknown>) => Promise<RunActionResult>;
  /** Cancel a non-terminal run. Returns a confirm result. */
  cancel: (runId: string) => Promise<{ ok: boolean; message: string }>;
}

export function useFlowRuns(flowId: string | null): FlowRunsState {
  const [runs, setRuns] = useState<FlowRun[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState<boolean>(false);
  const inFlightRef = useRef<boolean>(false);

  const refresh = useCallback(async (): Promise<void> => {
    if (!flowId) {
      setRuns([]);
      return;
    }
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setLoading(true);
    try {
      const res = await fetch(`/api/workflows/${flowId}/runs?limit=20`);
      if (!res.ok) {
        setError(`GET runs -> ${res.status}`);
        return;
      }
      const list = (await res.json()) as FlowRun[];
      setRuns(list);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      inFlightRef.current = false;
      setLoading(false);
    }
  }, [flowId]);

  // Initial load + adaptive poll.
  useEffect(() => {
    if (!flowId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = (): void => {
      if (cancelled) return;
      // Look at the latest snapshot via state — the closure captures the
      // current `runs` each render. `runs` updates after every refresh, so
      // we get fresh cadence decisions for free.
      const hasActive = runsRef.current.some((r) => !TERMINAL_STATUSES.has(r.status));
      const next = hasActive ? ACTIVE_POLL_MS : IDLE_POLL_MS;
      timer = setTimeout(async () => {
        // Skip work while the tab is hidden -- saves a tiny amount of CPU
        // and (more importantly) lets long-running tests pause cleanly when
        // a dev minimises the window.
        if (document.visibilityState !== "hidden") {
          await refresh();
        }
        schedule();
      }, next);
    };

    void refresh().then(schedule);

    // React to tab-visibility changes too: when the user comes back, kick
    // an immediate refresh instead of waiting out the timer.
    const onVis = (): void => {
      if (document.visibilityState === "visible") {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        void refresh().then(schedule);
      }
    };
    document.addEventListener("visibilitychange", onVis);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [flowId, refresh]);

  // Keep a ref of the latest `runs` so the polling closure sees fresh data
  // without re-creating the effect on every state change.
  const runsRef = useRef<FlowRun[]>(runs);
  useEffect(() => {
    runsRef.current = runs;
  }, [runs]);

  const start = useCallback<FlowRunsState["start"]>(
    async (payload) => {
      if (!flowId) return { ok: false, message: "no flow loaded" };
      setStarting(true);
      try {
        const res = await fetch(`/api/workflows/${flowId}/run`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            triggeredBy: "editor:run",
            // TESTING mode opts into per-step output streaming via the
            // engine's WEBSOCKET `streamStepProgress`. Without this the
            // run's `steps` map stays empty (PRODUCTION runs only write
            // the final uploadRunLog), which makes the canvas overlay
            // show every node as "not reached" -- the editor is a dev
            // surface where the user wants the granular trace.
            environment: "TESTING",
            ...(payload ? { payload } : {}),
          }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          return { ok: false, message: body.error ?? `run failed: ${res.status}` };
        }
        const body = (await res.json().catch(() => ({}))) as { runId?: string };
        // Optimistic refresh so the new run shows up immediately.
        void refresh();
        return { ok: true, message: "queued", runId: body.runId };
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) };
      } finally {
        setStarting(false);
      }
    },
    [flowId, refresh],
  );

  const cancel = useCallback<FlowRunsState["cancel"]>(
    async (runId) => {
      try {
        const res = await fetch(`/api/workflow-runs/${runId}/cancel`, { method: "POST" });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          return { ok: false, message: body.error ?? `cancel failed: ${res.status}` };
        }
        void refresh();
        return { ok: true, message: "cancel queued" };
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) };
      }
    },
    [refresh],
  );

  return { runs, loading, error, starting, refresh, start, cancel };
}

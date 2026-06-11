import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLiveData } from "../../shell/LiveDataContext";

const POLL_INTERVAL_MS = 5000;

export interface AgentTaskResult {
  success: boolean;
  response: string;
  /** True when the list payload capped `response`; the full text is at
   *  GET /api/agents/tasks/:id (see useFullTaskResponse). */
  response_truncated?: boolean;
  tools_used: string[];
  termination_reason: string;
}

export type LiveAgentTask = {
  id: string;
  status: string;
  task: string;
  started_at: number;
  completed_at: number | null;
  /** The sub-agent's final answer — present once the task finished. */
  result?: AgentTaskResult | null;
};

export interface LiveAgentInfo {
  id: string;
  role: { id: string; name: string };
  status: "active" | "idle" | "terminated";
  current_task: string | null;
  created_at: number;
  busy?: boolean;
  latest_task?: LiveAgentTask | null;
}

/**
 * Lazily fetch a task's full result text. The roster poll caps long
 * responses (`response_truncated`); when `active` flips true (the user
 * expanded the result), this pulls the untruncated text from
 * /api/agents/tasks/:id. Returns null until then — callers fall back
 * to the truncated preview.
 */
export function useFullTaskResponse(
  task: LiveAgentTask | null | undefined,
  active: boolean,
): string | null {
  const [full, setFull] = useState<string | null>(null);
  const taskId = task?.id ?? null;
  const truncated = task?.result?.response_truncated === true;

  useEffect(() => {
    setFull(null);
    if (!taskId || !truncated || !active) return;
    let cancelled = false;
    fetch(`/api/agents/tasks/${taskId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && typeof d?.result?.response === "string") {
          setFull(d.result.response);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [taskId, truncated, active]);

  return full;
}

export interface SpecialistInfo {
  id: string;
  name: string;
  description: string;
  authority_level: number;
  tools: string[];
}

/**
 * Roster row — what the UI actually renders. Static metadata (role, name,
 * authority) is sourced from the v2 ROSTER constant; live fields come
 * from `/api/agents` polling.
 */
export interface AgentRosterEntry {
  roleId: string;
  name: string;
  authority: number;
  tools: number;
  isPrimary?: boolean;
  live: LiveAgentInfo | null;
  /** Convenience: live.busy ?? false. PA is always considered active. */
  isActive: boolean;
  /** Where to place this agent in the orbital diagram. */
  ring: "center" | "inner" | "outer";
  orbital: { left: string; top: string };
}

/**
 * Static roster matching the legacy OfficePage. Keeps the UI deterministic
 * even when the daemon's spawned-agent list is empty (the Room shows the
 * full team of specialists, not just the ones currently busy).
 *
 * The orbital coordinates exactly mirror the legacy `ORBITAL_POSITIONS`
 * map so the Orbital View visually matches the prior page.
 */
export const ROSTER: ReadonlyArray<Omit<AgentRosterEntry, "live" | "isActive">> = [
  { roleId: "personal-assistant",    name: "Personal Assistant",   authority: 5, tools: 14, isPrimary: true,
    ring: "center", orbital: { left: "50%", top: "48%" } },
  { roleId: "software-engineer",     name: "Software Engineer",    authority: 4, tools: 8,
    ring: "inner",  orbital: { left: "30%", top: "25%" } },
  { roleId: "research-analyst",      name: "Research Analyst",     authority: 3, tools: 6,
    ring: "inner",  orbital: { left: "70%", top: "25%" } },
  { roleId: "content-writer",        name: "Content Writer",       authority: 3, tools: 5,
    ring: "inner",  orbital: { left: "22%", top: "55%" } },
  { roleId: "data-analyst",          name: "Data Analyst",         authority: 3, tools: 7,
    ring: "inner",  orbital: { left: "78%", top: "55%" } },
  { roleId: "system-administrator",  name: "System Administrator", authority: 4, tools: 10,
    ring: "inner",  orbital: { left: "50%", top: "72%" } },
  { roleId: "legal-advisor",         name: "Legal Advisor",        authority: 3, tools: 4,
    ring: "outer",  orbital: { left: "12%", top: "38%" } },
  { roleId: "financial-analyst",     name: "Financial Analyst",    authority: 3, tools: 5,
    ring: "outer",  orbital: { left: "15%", top: "18%" } },
  { roleId: "hr-specialist",         name: "HR Specialist",        authority: 2, tools: 4,
    ring: "outer",  orbital: { left: "50%", top: "8%" } },
  { roleId: "project-coordinator",   name: "Project Coordinator",  authority: 3, tools: 6,
    ring: "outer",  orbital: { left: "85%", top: "18%" } },
  { roleId: "marketing-strategist",  name: "Marketing Strategist", authority: 3, tools: 5,
    ring: "outer",  orbital: { left: "88%", top: "38%" } },
  { roleId: "customer-support",      name: "Customer Support",     authority: 2, tools: 4,
    ring: "outer",  orbital: { left: "50%", top: "85%" } },
];

export interface AgentActivityHistoryRow {
  id: string;
  agent_id: string;
  agent_name: string;
  event_type: "text" | "tool_call" | "done";
  data: unknown;
  task_id: string | null;
  timestamp: number;
  created_at: number;
}

export interface SpawnInput {
  specialist: string;
  task?: string;
  context?: string;
}

export interface SpawnResult {
  ok: boolean;
  message: string;
}

export function useAgentsData() {
  const live = useLiveData();
  const [liveAgents, setLiveAgents] = useState<LiveAgentInfo[]>([]);
  const [specialists, setSpecialists] = useState<SpecialistInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const inFlightRef = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const [agentsResp, specResp] = await Promise.all([
        fetch("/api/agents"),
        fetch("/api/agents/specialists"),
      ]);
      if (agentsResp.ok) {
        const data = (await agentsResp.json()) as LiveAgentInfo[];
        setLiveAgents(Array.isArray(data) ? data : []);
      }
      if (specResp.ok) {
        const data = (await specResp.json()) as { specialists: SpecialistInfo[] };
        setSpecialists(Array.isArray(data.specialists) ? data.specialists : []);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load agents");
    } finally {
      inFlightRef.current = false;
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

  // Match a live agent to a roster slot. Tries exact role.id first, then
  // falls back to a slugged role.name (matches the legacy heuristic).
  const findLive = useCallback(
    (roleId: string): LiveAgentInfo | null => {
      return (
        liveAgents.find(
          (a) =>
            a.role?.id === roleId ||
            a.role?.name?.toLowerCase().replace(/\s+/g, "-") === roleId,
        ) ?? null
      );
    },
    [liveAgents],
  );

  const roster = useMemo<AgentRosterEntry[]>(() => {
    return ROSTER.map((r) => {
      const liveInfo = findLive(r.roleId);
      const isActive = Boolean(r.isPrimary || liveInfo?.busy);
      return { ...r, live: liveInfo, isActive };
    });
  }, [findLive]);

  const stats = useMemo(() => {
    const total = roster.length;
    const active = roster.filter((a) => a.isActive).length;
    // Live tail: completed events from this session. Mirrors legacy stat
    // (which was also session-only). Backed by persisted history would
    // require a stats endpoint; deferred — session count is informative.
    const completed24h = live.agentActivity.filter(
      (e) => e.eventType === "done",
    ).length;
    const delegationDepth = active > 1 ? 2 : 1;
    return { total, active, completed24h, delegationDepth };
  }, [roster, live.agentActivity]);

  const spawn = useCallback(async (input: SpawnInput): Promise<SpawnResult> => {
    try {
      const resp = await fetch("/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          specialist: input.specialist,
          task: input.task?.trim() || undefined,
          context: input.context?.trim() || undefined,
        }),
      });
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(text || `HTTP ${resp.status}`);
      }
      const data = await resp.json() as { assignment?: { message?: string } | null };
      // Refresh roster so the new agent shows up immediately.
      refresh();
      return { ok: true, message: data.assignment?.message ?? "Agent spawned." };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : "Failed to spawn agent.",
      };
    }
  }, [refresh]);

  const terminate = useCallback(async (id: string): Promise<SpawnResult> => {
    try {
      const resp = await fetch(`/api/agents/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(text || `HTTP ${resp.status}`);
      }
      refresh();
      return { ok: true, message: "Agent terminated." };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : "Failed to terminate agent.",
      };
    }
  }, [refresh]);

  return {
    roster,
    specialists,
    stats,
    error,
    /** Live activity from this WS session. Newest-first. */
    liveActivity: live.agentActivity,
    refresh,
    spawn,
    terminate,
  };
}

/**
 * Per-agent activity history (Phase 6.3 — backed by the new persisted
 * `/api/agents/:id/activity` endpoint). Used by the agent detail / drill-in
 * views. Returns null while loading, [] on error or unknown agent.
 */
export function useAgentActivityHistory(agentId: string | null, limit = 50) {
  const [events, setEvents] = useState<AgentActivityHistoryRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!agentId) {
      setEvents([]);
      return;
    }
    let cancelled = false;
    fetch(`/api/agents/${encodeURIComponent(agentId)}/activity?limit=${limit}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data: { events: AgentActivityHistoryRow[]; total: number }) => {
        if (cancelled) return;
        setEvents(Array.isArray(data.events) ? data.events : []);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load activity");
        setEvents([]);
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, limit]);

  return { events, error };
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const POLL_INTERVAL_MS = 5000;

export type ProjectStatus = "stopped" | "starting" | "running" | "error";

export interface Project {
  id: string;
  name: string;
  path: string;
  framework: string;
  devPort: number | null;
  devServerPid: number | null;
  status: ProjectStatus;
  gitBranch: string | null;
  gitDirty: boolean;
  createdAt: number;
  lastOpenedAt: number;
  githubUrl: string | null;
}

interface ActionResult {
  ok: boolean;
  message: string;
}

/**
 * Workspaces Room hook — loads /api/sites/projects, exposes lifecycle
 * actions (create, start/stop dev server, delete). Polls every 5s
 * because the dev server status changes externally (e.g. crash, port
 * conflict) and we want to surface that without manual refresh.
 *
 * Reuses 21 existing endpoints — no new backend.
 */
export function useWorkspacesData() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const inFlightRef = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const resp = await fetch("/api/sites/projects");
      if (resp.ok) {
        const data = (await resp.json()) as Project[];
        setProjects(Array.isArray(data) ? data : []);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load projects");
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

  const stats = useMemo(() => {
    const total = projects.length;
    const running = projects.filter((p) => p.status === "running").length;
    const dirty = projects.filter((p) => p.gitDirty).length;
    const linked = projects.filter((p) => p.githubUrl).length;
    return { total, running, dirty, linked };
  }, [projects]);

  const findByName = useCallback(
    (name: string): Project | null => {
      const q = name.trim().toLowerCase();
      if (!q) return null;

      // Normalize both sides: lowercase, replace any non-alphanumeric run
      // (dash, underscore, apostrophe, space, period) with a single space,
      // collapse, trim. Lets "jarvis landing" find "jarvis-landing" and
      // "jarv's landing" find the same.
      const norm = (s: string) =>
        s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      const qNorm = norm(q);
      if (!qNorm) return null;
      const qTokens = qNorm.split(" ").filter(Boolean);

      // 1. exact normalized match
      const exact = projects.find((p) => norm(p.name) === qNorm);
      if (exact) return exact;

      // 2. substring either direction (handles partials like "landing"
      //    matching "jarvis-landing" and full query matching a longer name)
      const sub = projects.find((p) => {
        const n = norm(p.name);
        return n.includes(qNorm) || qNorm.includes(n);
      });
      if (sub) return sub;

      // 3. token overlap — pick the project whose tokens cover the most
      //    query tokens (each query token must appear as a prefix of some
      //    project token). Threshold: at least one token matches AND at
      //    least half the query tokens match.
      let best: { project: Project; score: number } | null = null;
      for (const p of projects) {
        const nTokens = norm(p.name).split(" ").filter(Boolean);
        let hits = 0;
        for (const qt of qTokens) {
          if (nTokens.some((nt) => nt.startsWith(qt) || qt.startsWith(nt))) {
            hits++;
          }
        }
        if (hits > 0 && hits / qTokens.length >= 0.5) {
          if (!best || hits > best.score) best = { project: p, score: hits };
        }
      }
      return best?.project ?? null;
    },
    [projects],
  );

  const createProject = useCallback(
    async (input: {
      name: string;
      template?: string;
      gitAuthor?: { name: string; email: string };
    }): Promise<{ ok: true; project: Project } | { ok: false; message: string }> => {
      try {
        const resp = await fetch("/api/sites/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: input.name,
            template: input.template ?? "vite-react",
            gitAuthor: input.gitAuthor,
          }),
        });
        if (!resp.ok) throw new Error(await resp.text() || `HTTP ${resp.status}`);
        const project = (await resp.json()) as Project;
        refresh();
        return { ok: true, project };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : "Failed" };
      }
    },
    [refresh],
  );

  const startServer = useCallback(
    async (id: string): Promise<ActionResult> => {
      try {
        const resp = await fetch(`/api/sites/projects/${encodeURIComponent(id)}/start`, {
          method: "POST",
        });
        if (!resp.ok) throw new Error(await resp.text() || `HTTP ${resp.status}`);
        const updated = (await resp.json()) as Project;
        refresh();
        return {
          ok: true,
          message: updated.devPort
            ? `Dev server running on port ${updated.devPort}.`
            : "Dev server starting.",
        };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : "Failed" };
      }
    },
    [refresh],
  );

  const stopServer = useCallback(
    async (id: string): Promise<ActionResult> => {
      try {
        const resp = await fetch(`/api/sites/projects/${encodeURIComponent(id)}/stop`, {
          method: "POST",
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        refresh();
        return { ok: true, message: "Dev server stopped." };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : "Failed" };
      }
    },
    [refresh],
  );

  const deleteProject = useCallback(
    async (id: string): Promise<ActionResult> => {
      try {
        const resp = await fetch(`/api/sites/projects/${encodeURIComponent(id)}`, {
          method: "DELETE",
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        refresh();
        return { ok: true, message: "Project deleted." };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : "Failed" };
      }
    },
    [refresh],
  );

  return {
    projects,
    stats,
    loading,
    error,
    refresh,
    findByName,
    createProject,
    startServer,
    stopServer,
    deleteProject,
  };
}

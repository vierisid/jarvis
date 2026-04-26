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
      const exact = projects.find((p) => p.name.toLowerCase() === q);
      if (exact) return exact;
      return projects.find((p) => p.name.toLowerCase().includes(q)) ?? null;
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

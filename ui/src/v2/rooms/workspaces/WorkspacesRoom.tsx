import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  Box,
  Code2,
  ExternalLink,
  GitBranch,
  Plus,
  Power,
  RefreshCw,
  Search,
  Square,
  X,
} from "lucide-react";
import { Chip, Icon } from "../../ui";
import { openRoom } from "../../router";
import { RoomShell } from "../RoomShell";
import { useRoomActions } from "../useRoomActionBus";
import {
  useWorkspacesData,
  type Project,
  type ProjectStatus,
} from "./useWorkspacesData";
import {
  setWorkspacesUIState,
  useWorkspacesUIState,
} from "./workspacesUIStore";
// Legacy embeds — see Workflows Room precedent (embeds WorkflowCanvas).
// Heavy IDE components (CodeMirror editor, iframe preview, git panel,
// file tree) are battle-tested in legacy; rebuilding in v2 is a 3-day
// side quest. Embed-with-retheming gives feature parity in 0.5 days.
import { SiteTopBar } from "../../../components/sites/SiteTopBar";
import { SiteLeftPanel } from "../../../components/sites/SiteLeftPanel";
import { SiteRightPanel } from "../../../components/sites/SiteRightPanel";
import { SiteNewProjectModal } from "../../../components/sites/SiteNewProjectModal";
import "./WorkspacesRoom.css";

const STATUS_TONE: Record<ProjectStatus, "ok" | "neutral" | "warn" | "accent"> = {
  stopped: "neutral",
  starting: "warn",
  running: "ok",
  error: "accent",
};

const STATUS_LABEL: Record<ProjectStatus, string> = {
  stopped: "Stopped",
  starting: "Starting…",
  running: "Running",
  error: "Error",
};

export type RoomBodyMode = "inline" | "expanded";

export function WorkspacesRoomBody({ mode }: { mode: RoomBodyMode }) {
  const data = useWorkspacesData();
  // Shared store: IDE selection has to survive across the inline body
  // and the fullscreen body (both can be mounted at the same time).
  const ui = useWorkspacesUIState();
  const { openTabIds, activeProjectId, leftTab, rightTab, openFilePath } = ui;
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [toast, setToast] = useState<{ text: string; tone: "ok" | "warn" } | null>(null);

  // Resolve open Project objects from the live data. If a tab references
  // a project that's no longer in the list (deleted), it gets dropped.
  const openTabs = useMemo<Project[]>(
    () =>
      openTabIds
        .map((id) => data.projects.find((p) => p.id === id))
        .filter((p): p is Project => Boolean(p)),
    [openTabIds, data.projects],
  );

  const setLeftTab = useCallback((next: "chat" | "files") => {
    setWorkspacesUIState((prev) => ({ ...prev, leftTab: next }));
  }, []);
  const setRightTab = useCallback((next: "preview" | "editor") => {
    setWorkspacesUIState((prev) => ({ ...prev, rightTab: next }));
  }, []);
  const setOpenFilePath = useCallback((next: string | null) => {
    setWorkspacesUIState((prev) => ({ ...prev, openFilePath: next }));
  }, []);
  const setActiveProjectId = useCallback((next: string | null) => {
    setWorkspacesUIState((prev) => ({ ...prev, activeProjectId: next }));
  }, []);

  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(id);
  }, [toast]);

  const filteredProjects = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return data.projects;
    return data.projects.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.framework.toLowerCase().includes(q),
    );
  }, [data.projects, search]);

  const activeProject = openTabs.find((p) => p.id === activeProjectId) ?? null;

  const openProject = useCallback(
    async (project: Project) => {
      setWorkspacesUIState((prev) => ({
        ...prev,
        openTabIds: prev.openTabIds.includes(project.id)
          ? prev.openTabIds
          : [...prev.openTabIds, project.id],
        activeProjectId: project.id,
      }));
      // Inline RoomWindow can't render the embedded IDE — escalate so
      // the click on Open actually shows the editor instead of leaving
      // the list view untouched.
      if (mode === "inline") openRoom("workspaces");
      // Auto-start dev server if stopped — same UX as legacy SitesPage.
      if (project.status === "stopped") {
        const r = await data.startServer(project.id);
        if (r.ok) {
          // Refresh to pick up new devPort.
          data.refresh();
        }
      }
    },
    [data, mode],
  );

  const closeTab = useCallback(
    async (projectId: string) => {
      try {
        await data.stopServer(projectId);
      } catch { /* ignore */ }
      setWorkspacesUIState((prev) => {
        const remaining = prev.openTabIds.filter((id) => id !== projectId);
        return {
          ...prev,
          openTabIds: remaining,
          activeProjectId:
            prev.activeProjectId === projectId
              ? (remaining[remaining.length - 1] ?? null)
              : prev.activeProjectId,
        };
      });
    },
    [data],
  );

  const backToList = useCallback(() => {
    setActiveProjectId(null);
  }, [setActiveProjectId]);

  // (openTabs are now resolved from data.projects via the memo above —
  // no manual sync needed.)

  // Voice room actions.
  useRoomActions("workspaces", (action, args) => {
    switch (action) {
      case "switch_view": {
        const v = String(args.view);
        if (v === "list") {
          backToList();
          return true;
        }
        if (v === "detail") {
          if (openTabs.length > 0) {
            setActiveProjectId(openTabs[openTabs.length - 1]!.id);
            if (mode === "inline") openRoom("workspaces");
            return true;
          }
          return false;
        }
        return false;
      }
      case "search":
        setSearch(typeof args.query === "string" ? args.query : "");
        backToList();
        return true;
      case "select_project": {
        const name = typeof args.name === "string" ? args.name : "";
        const p = data.findByName(name);
        if (!p) return false;
        openProject(p);
        // The IDE only renders when the room is expanded (the inline
        // RoomWindow always passes mode="inline"). Without this escalation
        // the ack fires but the user sees the list view forever — looks
        // like nothing happened. Mirror what a click on a project card
        // would do if it could only render fullscreen.
        if (mode === "inline") openRoom("workspaces");
        return true;
      }
      case "back_to_list":
        backToList();
        return true;
      case "create_project": {
        const name = typeof args.name === "string" ? args.name.trim() : "";
        if (!name) return false;
        const template = typeof args.template === "string" ? args.template : "vite-react";
        (async () => {
          const r = await data.createProject({ name, template });
          if (r.ok) {
            openProject(r.project);
            setToast({ text: `Created "${r.project.name}".`, tone: "ok" });
          } else {
            setToast({ text: r.message, tone: "warn" });
          }
        })();
        return true;
      }
      case "start_server": {
        const name = typeof args.name === "string" ? args.name : "";
        const p = name ? data.findByName(name) : activeProject;
        if (!p) return false;
        (async () => {
          const r = await data.startServer(p.id);
          setToast({ text: r.ok ? `${p.name}: ${r.message}` : r.message, tone: r.ok ? "ok" : "warn" });
        })();
        return true;
      }
      case "stop_server": {
        const name = typeof args.name === "string" ? args.name : "";
        const p = name ? data.findByName(name) : activeProject;
        if (!p) return false;
        (async () => {
          const r = await data.stopServer(p.id);
          setToast({ text: r.ok ? `${p.name}: ${r.message}` : r.message, tone: r.ok ? "ok" : "warn" });
        })();
        return true;
      }
      default:
        return false;
    }
  });

  // ── Detail view (project open) — embed legacy IDE ──
  if (activeProjectId && activeProject && mode === "expanded") {
    return (
      <div className="v2-ws v2-ws--detail">
        {toast && (
          <div role="status" aria-live="polite" className="v2-ws__toast" data-tone={toast.tone}>
            {toast.text}
          </div>
        )}
        <div className="v2-ws__detail-chrome">
          <button
            type="button"
            className="v2-ws__back-btn"
            onClick={backToList}
            aria-label="Back to project list"
          >
            <Icon icon={ArrowLeft} size="sm" />
            All projects
          </button>
          <div className="v2-ws__detail-title">
            <span className="v2-ws__project-name">{activeProject.name}</span>
            <Chip tone={STATUS_TONE[activeProject.status]} dot>
              {STATUS_LABEL[activeProject.status]}
            </Chip>
            {activeProject.gitBranch && (
              <span className="v2-ws__branch">
                <Icon icon={GitBranch} size="sm" />
                {activeProject.gitBranch}
                {activeProject.gitDirty && <span className="v2-ws__dirty">●</span>}
              </span>
            )}
            {activeProject.devPort && (
              <span className="v2-ws__port">localhost:{activeProject.devPort}</span>
            )}
          </div>
        </div>
        <div className="v2-ws__detail-ide">
          <SiteTopBar
            openTabs={openTabs}
            activeProjectId={activeProjectId}
            projects={data.projects}
            onSelectTab={setActiveProjectId}
            onCloseTab={closeTab}
            onOpenProject={openProject}
            onNewProject={() => setCreateOpen(true)}
            onStopServer={async () => {
              if (activeProjectId) {
                const r = await data.stopServer(activeProjectId);
                setToast({ text: r.message, tone: r.ok ? "ok" : "warn" });
              }
            }}
            onGitHubChange={() => data.refresh()}
          />
          <div className="v2-ws__detail-split">
            <SiteLeftPanel
              leftTab={leftTab}
              setLeftTab={setLeftTab}
              projectId={activeProjectId}
              onFileSelect={(path: string) => {
                setOpenFilePath(path);
                setRightTab("editor");
              }}
              sendMessage={() => { /* chat tab not wired in v2 — file tab is primary */ }}
              isConnected={false}
              messages={[]}
            />
            <SiteRightPanel
              rightTab={rightTab}
              setRightTab={setRightTab}
              project={activeProject}
              openFilePath={openFilePath}
            />
          </div>
        </div>
        {createOpen && (
          <SiteNewProjectModal
            onClose={() => setCreateOpen(false)}
            onCreated={(p: Project) => {
              setCreateOpen(false);
              openProject(p);
              data.refresh();
            }}
          />
        )}
      </div>
    );
  }

  // ── List view (default) ──
  return (
    <div className={`v2-ws v2-ws--${mode}`}>
      {/* Stats */}
      <div className="v2-ws__stats">
        <StatCard label="Projects" value={data.stats.total} sub="all workspaces" />
        <StatCard
          label="Running"
          value={data.stats.running}
          sub="dev servers up"
          tone={data.stats.running > 0 ? "ok" : "neutral"}
        />
        <StatCard
          label="Dirty"
          value={data.stats.dirty}
          sub="uncommitted changes"
          tone={data.stats.dirty > 0 ? "warn" : "neutral"}
        />
        <StatCard
          label="Linked"
          value={data.stats.linked}
          sub="connected to GitHub"
        />
      </div>

      {/* Toolbar */}
      <div className="v2-ws__toolbar">
        <div className="v2-ws__search">
          <Icon icon={Search} size="sm" />
          <input
            className="v2-ws__search-input"
            type="text"
            placeholder="Search projects…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search projects"
          />
        </div>
        <button
          type="button"
          className="v2-ws__refresh"
          onClick={data.refresh}
          aria-label="Refresh"
          title="Refresh"
        >
          <Icon icon={RefreshCw} size="sm" />
        </button>
        <button
          type="button"
          className="v2-ws__new-btn"
          onClick={() => setCreateOpen(true)}
        >
          <Icon icon={Plus} size="sm" />
          New project
        </button>
      </div>

      {data.error && <div className="v2-ws__error">{data.error}</div>}

      {/* Project grid */}
      {data.loading && filteredProjects.length === 0 ? (
        <div className="v2-ws__empty">Loading projects…</div>
      ) : filteredProjects.length === 0 ? (
        <div className="v2-ws__empty">
          {search.trim()
            ? "No projects match the search."
            : "No projects yet. Create one to get started."}
        </div>
      ) : (
        <ul className="v2-ws__grid" role="list">
          {filteredProjects.map((p) => (
            <li key={p.id}>
              <ProjectCard
                project={p}
                onOpen={() => openProject(p)}
                onStart={async () => {
                  const r = await data.startServer(p.id);
                  setToast({ text: r.message, tone: r.ok ? "ok" : "warn" });
                }}
                onStop={async () => {
                  const r = await data.stopServer(p.id);
                  setToast({ text: r.message, tone: r.ok ? "ok" : "warn" });
                }}
                onDelete={async () => {
                  if (!confirm(`Delete "${p.name}"? Cannot be undone.`)) return;
                  const r = await data.deleteProject(p.id);
                  setToast({ text: r.message, tone: r.ok ? "ok" : "warn" });
                }}
              />
            </li>
          ))}
        </ul>
      )}

      {createOpen && (
        <SiteNewProjectModal
          onClose={() => setCreateOpen(false)}
          onCreated={(p: Project) => {
            setCreateOpen(false);
            openProject(p);
            data.refresh();
          }}
        />
      )}

      {toast && (
        <div role="status" aria-live="polite" className="v2-ws__toast" data-tone={toast.tone}>
          {toast.text}
        </div>
      )}
    </div>
  );
}

export function WorkspacesRoom() {
  return (
    <RoomShell
      title="Workspaces"
      subtitle="dev projects · git · dev servers"
      breadcrumb={["Workspaces"]}
    >
      <WorkspacesRoomBody mode="expanded" />
    </RoomShell>
  );
}

/* ─────────── Subcomponents ─────────── */

function StatCard({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: number | string;
  sub: string;
  tone?: "neutral" | "ok" | "warn" | "accent";
}) {
  return (
    <div className="v2-ws__stat" data-tone={tone ?? "neutral"}>
      <div className="v2-ws__stat-label">{label}</div>
      <div className="v2-ws__stat-value">{value}</div>
      <div className="v2-ws__stat-sub">{sub}</div>
    </div>
  );
}

function ProjectCard({
  project,
  onOpen,
  onStart,
  onStop,
  onDelete,
}: {
  project: Project;
  onOpen: () => void;
  onStart: () => void;
  onStop: () => void;
  onDelete: () => void;
}) {
  const isRunning = project.status === "running";
  return (
    <article className="v2-ws__card" data-status={project.status}>
      <div className="v2-ws__card-head">
        <div className="v2-ws__card-icon">
          <Icon icon={Code2} size="md" />
        </div>
        <div className="v2-ws__card-id">
          <button type="button" className="v2-ws__card-name" onClick={onOpen}>
            {project.name}
          </button>
          <div className="v2-ws__card-meta">
            <span className="v2-ws__framework">{project.framework}</span>
            <Chip tone={STATUS_TONE[project.status]} dot>
              {STATUS_LABEL[project.status]}
            </Chip>
          </div>
        </div>
      </div>

      <div className="v2-ws__card-info">
        {project.gitBranch && (
          <span className="v2-ws__card-branch">
            <Icon icon={GitBranch} size="sm" />
            {project.gitBranch}
            {project.gitDirty && <span className="v2-ws__dirty">●</span>}
          </span>
        )}
        {project.devPort && isRunning && (
          <span className="v2-ws__card-port">localhost:{project.devPort}</span>
        )}
        {project.githubUrl && (
          <a
            className="v2-ws__card-github"
            href={project.githubUrl}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            title={project.githubUrl}
          >
            <Icon icon={ExternalLink} size="sm" />
          </a>
        )}
        <span className="v2-ws__card-time">opened {formatRelative(project.lastOpenedAt)}</span>
      </div>

      <div className="v2-ws__card-actions">
        {isRunning ? (
          <button
            type="button"
            className="v2-ws__btn v2-ws__btn--secondary"
            onClick={onStop}
          >
            <Icon icon={Square} size="sm" />
            Stop
          </button>
        ) : (
          <button
            type="button"
            className="v2-ws__btn v2-ws__btn--secondary"
            onClick={onStart}
          >
            <Icon icon={Power} size="sm" />
            Start
          </button>
        )}
        <button
          type="button"
          className="v2-ws__btn v2-ws__btn--icon"
          onClick={onDelete}
          aria-label="Delete project"
          title="Delete"
        >
          <Icon icon={X} size="sm" />
        </button>
        <div className="v2-ws__card-actions-spacer" />
        <button
          type="button"
          className="v2-ws__btn v2-ws__btn--primary"
          onClick={onOpen}
        >
          Open
        </button>
      </div>
    </article>
  );
}

/* ─────────── helpers ─────────── */

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day === 1) return "yesterday";
  if (day < 7) return `${day}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// silence unused-import lints
void Box;

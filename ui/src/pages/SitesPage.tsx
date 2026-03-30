import React, { useState, useEffect, useCallback } from "react";
import { api, useApiData } from "../hooks/useApi";
import { SiteTopBar } from "../components/sites/SiteTopBar";
import { SiteLeftPanel } from "../components/sites/SiteLeftPanel";
import { SiteRightPanel } from "../components/sites/SiteRightPanel";
import { SiteNewProjectModal } from "../components/sites/SiteNewProjectModal";

export type Project = {
  id: string;
  name: string;
  path: string;
  framework: string;
  devPort: number | null;
  devServerPid: number | null;
  status: "stopped" | "starting" | "running" | "error";
  gitBranch: string | null;
  gitDirty: boolean;
  createdAt: number;
  lastOpenedAt: number;
  githubUrl: string | null;
};

export type FileEntry = {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: FileEntry[];
  size?: number;
  modified?: number;
};

export type GitBranch = {
  name: string;
  current: boolean;
};

export type GitCommit = {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  date: number;
};

type Props = {
  sendMessage: (msg: string, options?: { projectId?: string }) => void;
  isConnected: boolean;
  messages: import("../hooks/useWebSocket").ChatMessage[];
};

export default function SitesPage({ sendMessage, isConnected, messages }: Props) {
  const [openTabs, setOpenTabs] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [leftTab, setLeftTab] = useState<"chat" | "files">("chat");
  const [rightTab, setRightTab] = useState<"preview" | "editor">("preview");
  const [openFilePath, setOpenFilePath] = useState<string | null>(null);
  const [showNewProject, setShowNewProject] = useState(false);

  // Fetch project list
  const { data: projects, refetch: refetchProjects } = useApiData<Project[]>("/api/sites/projects", []);

  // Active project
  const activeProject = openTabs.find((p) => p.id === activeProjectId) ?? null;

  // Open a project tab
  const openProject = useCallback(async (project: Project) => {
    setOpenTabs((prev) => {
      if (prev.some((p) => p.id === project.id)) return prev;
      return [...prev, project];
    });
    setActiveProjectId(project.id);

    // Auto-start dev server
    if (project.status === "stopped") {
      try {
        const updated = await api<Project>(`/api/sites/projects/${project.id}/start`, { method: "POST" });
        setOpenTabs((prev) => prev.map((p) => (p.id === project.id ? updated : p)));
      } catch (err) {
        console.error("Failed to start dev server:", err);
      }
    }
  }, []);

  // Close a project tab
  const closeTab = useCallback(async (projectId: string) => {
    // Stop dev server
    try {
      await api(`/api/sites/projects/${projectId}/stop`, { method: "POST" });
    } catch { /* ignore */ }

    setOpenTabs((prev) => prev.filter((p) => p.id !== projectId));
    if (activeProjectId === projectId) {
      setOpenTabs((prev) => {
        setActiveProjectId(prev.length > 0 ? prev[0]!.id : null);
        return prev;
      });
    }
  }, [activeProjectId]);

  // Handle file selection from tree
  const handleFileSelect = useCallback((filePath: string) => {
    setOpenFilePath(filePath);
    setRightTab("editor");
  }, []);

  // Delete a project
  const deleteProject = useCallback(async (projectId: string) => {
    try {
      await api(`/api/sites/projects/${projectId}`, { method: "DELETE" });
      setOpenTabs((prev) => prev.filter((p) => p.id !== projectId));
      if (activeProjectId === projectId) setActiveProjectId(null);
      refetchProjects();
    } catch (err) {
      console.error("Failed to delete project:", err);
    }
  }, [activeProjectId, refetchProjects]);

  // Handle new project creation
  const handleProjectCreated = useCallback((project: Project) => {
    setShowNewProject(false);
    refetchProjects();
    openProject(project);
  }, [openProject, refetchProjects]);

  // Refresh active project status periodically
  useEffect(() => {
    if (!activeProjectId) return;
    const interval = setInterval(async () => {
      try {
        const updated = await api<Project>(`/api/sites/projects/${activeProjectId}`);
        setOpenTabs((prev) => prev.map((p) => (p.id === activeProjectId ? { ...p, ...updated } : p)));
      } catch { /* ignore */ }
    }, 5000);
    return () => clearInterval(interval);
  }, [activeProjectId]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--j-bg)" }}>
      {/* Top bar with project tabs + git controls */}
      <SiteTopBar
        openTabs={openTabs}
        activeProjectId={activeProjectId}
        projects={projects ?? []}
        onSelectTab={setActiveProjectId}
        onCloseTab={closeTab}
        onOpenProject={openProject}
        onNewProject={() => setShowNewProject(true)}
        onStopServer={async () => {
          if (activeProjectId) {
            await api(`/api/sites/projects/${activeProjectId}/stop`, { method: "POST" });
            setOpenTabs((prev) => prev.map((p) => (p.id === activeProjectId ? { ...p, status: "stopped" as const, devPort: null } : p)));
          }
        }}
        onGitHubChange={async () => {
          // Refresh the active project to pick up githubUrl changes
          if (activeProjectId) {
            try {
              const updated = await api<Project>(`/api/sites/projects/${activeProjectId}`);
              setOpenTabs((prev) => prev.map((p) => (p.id === activeProjectId ? { ...p, ...updated } : p)));
            } catch { /* ignore */ }
          }
          refetchProjects();
        }}
      />

      {/* Main content */}
      {!activeProjectId ? (
        /* No project selected — show project list */
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", overflow: "auto" }}>
          <div style={{ maxWidth: 500, width: "100%", padding: "40px 20px" }}>
            <h2 style={{ fontSize: "16px", fontWeight: 600, color: "var(--j-text)", marginBottom: "8px", textAlign: "center" }}>
              Site Builder
            </h2>
            <p style={{ fontSize: "12px", color: "var(--j-text-muted)", textAlign: "center", marginBottom: "24px" }}>
              Select a project to open or create a new one
            </p>

            {projects && projects.length > 0 ? (
              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                {projects.map((p) => (
                  <div
                    key={p.id}
                    style={{
                      display: "flex", alignItems: "center", gap: "8px",
                    }}
                  >
                    <button
                      onClick={() => openProject(p)}
                      style={{
                        display: "flex", alignItems: "center", gap: "12px",
                        padding: "12px 16px", background: "var(--j-surface)",
                        border: "1px solid var(--j-border)", borderRadius: "8px",
                        color: "var(--j-text)", cursor: "pointer", textAlign: "left",
                        flex: 1,
                      }}
                    >
                      <div style={{ width: 8, height: 8, borderRadius: "50%", background: p.status === "running" ? "var(--j-success)" : "var(--j-text-muted)", flexShrink: 0 }} />
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: "13px", fontWeight: 600 }}>{p.name}</div>
                        <div style={{ fontSize: "11px", color: "var(--j-text-muted)", marginTop: 2 }}>
                          {p.framework} {p.gitBranch ? `· ${p.gitBranch}` : ""} {p.gitDirty ? "· modified" : ""}
                        </div>
                      </div>
                      <span style={{ fontSize: "11px", color: "var(--j-text-muted)" }}>
                        {new Date(p.lastOpenedAt).toLocaleDateString()}
                      </span>
                    </button>
                    <button
                      title="Delete project"
                      onClick={() => {
                        if (confirm(`Delete project "${p.name}"? This will remove all project files.`)) {
                          deleteProject(p.id);
                        }
                      }}
                      style={{
                        padding: "8px",
                        background: "none",
                        border: "1px solid transparent",
                        borderRadius: "6px",
                        color: "var(--j-text-muted)",
                        cursor: "pointer",
                        fontSize: "14px",
                        lineHeight: 1,
                        flexShrink: 0,
                        transition: "color 0.15s, border-color 0.15s",
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.color = "var(--j-error, #ff4d4f)";
                        e.currentTarget.style.borderColor = "var(--j-error, #ff4d4f)";
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.color = "var(--j-text-muted)";
                        e.currentTarget.style.borderColor = "transparent";
                      }}
                    >
                      &#x2715;
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ textAlign: "center", color: "var(--j-text-muted)", fontSize: "12px", padding: "20px" }}>
                No projects yet
              </div>
            )}

            <div style={{ textAlign: "center", marginTop: "16px" }}>
              <button onClick={() => setShowNewProject(true)} style={{
                padding: "8px 20px", fontSize: "12px", fontWeight: 600,
                background: "rgba(0, 212, 255, 0.15)", border: "1px solid rgba(0, 212, 255, 0.4)",
                borderRadius: "6px", color: "var(--j-accent)", cursor: "pointer",
              }}>
                + New Project
              </button>
            </div>
          </div>
        </div>
      ) : (
        /* Project selected — show split panels */
        <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
          {/* Left panel (25%) */}
          <div style={{ width: "25%", minWidth: 240, maxWidth: 400, display: "flex", flexDirection: "column", borderRight: "1px solid var(--j-border)" }}>
            <SiteLeftPanel
              leftTab={leftTab}
              setLeftTab={setLeftTab}
              projectId={activeProjectId}
              onFileSelect={handleFileSelect}
              sendMessage={sendMessage}
              isConnected={isConnected}
              messages={messages}
            />
          </div>

          {/* Right panel (75%) */}
          <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <SiteRightPanel
              rightTab={rightTab}
              setRightTab={setRightTab}
              project={activeProject}
              openFilePath={openFilePath}
            />
          </div>
        </div>
      )}

      {/* New project modal */}
      {showNewProject && (
        <SiteNewProjectModal
          onClose={() => setShowNewProject(false)}
          onCreated={handleProjectCreated}
        />
      )}
    </div>
  );
}

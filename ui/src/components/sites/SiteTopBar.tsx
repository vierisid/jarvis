import React from "react";
import type { Project } from "../../pages/SitesPage";
import { SiteGitPanel } from "./SiteGitPanel";

type Props = {
  openTabs: Project[];
  activeProjectId: string | null;
  projects: Project[];
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onOpenProject: (project: Project) => void;
  onNewProject: () => void;
  onStopServer: () => void;
  onGitHubChange: () => void;
};

export function SiteTopBar({
  openTabs, activeProjectId, projects, onSelectTab, onCloseTab, onOpenProject, onNewProject, onStopServer, onGitHubChange,
}: Props) {
  const activeProject = openTabs.find((p) => p.id === activeProjectId);
  const [showProjectList, setShowProjectList] = React.useState(false);
  const [showGitPanel, setShowGitPanel] = React.useState(false);

  return (
    <div style={barStyle}>
      {/* Project tabs */}
      <div style={{ display: "flex", gap: "2px", flex: 1, overflow: "hidden" }}>
        {openTabs.map((project) => (
          <div
            key={project.id}
            style={{
              ...tabStyle,
              background: project.id === activeProjectId ? "var(--j-surface)" : "transparent",
              borderBottom: project.id === activeProjectId ? "2px solid var(--j-accent)" : "2px solid transparent",
            }}
            onClick={() => onSelectTab(project.id)}
          >
            <span style={statusDot(project.status)} />
            <span style={{ fontSize: "12px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {project.name}
            </span>
            <button
              onClick={(e) => { e.stopPropagation(); onCloseTab(project.id); }}
              style={closeBtnStyle}
              title="Close tab"
            >
              x
            </button>
          </div>
        ))}

        {/* Open project dropdown */}
        <div style={{ position: "relative" }}>
          <button
            onClick={() => setShowProjectList(!showProjectList)}
            style={addTabStyle}
            title="Open project"
          >
            +
          </button>
          {showProjectList && (
            <div style={dropdownStyle}>
              {projects.filter((p) => !openTabs.some((t) => t.id === p.id)).map((p) => (
                <button
                  key={p.id}
                  onClick={() => { onOpenProject(p); setShowProjectList(false); }}
                  style={dropdownItemStyle}
                >
                  {p.name}
                  <span style={{ fontSize: "10px", color: "var(--j-text-muted)", marginLeft: "auto" }}>{p.framework}</span>
                </button>
              ))}
              {projects.filter((p) => !openTabs.some((t) => t.id === p.id)).length === 0 && (
                <div style={{ padding: "8px 12px", fontSize: "11px", color: "var(--j-text-muted)" }}>No other projects</div>
              )}
              <div style={{ borderTop: "1px solid var(--j-border)", marginTop: "4px", paddingTop: "4px" }}>
                <button onClick={() => { onNewProject(); setShowProjectList(false); }} style={{ ...dropdownItemStyle, color: "var(--j-accent)" }}>
                  + New Project
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Right side: git info + controls */}
      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginLeft: "auto", paddingLeft: "12px" }}>
        {activeProject && (
          <>
            {activeProject.gitBranch && (
              <button
                onClick={() => setShowGitPanel(!showGitPanel)}
                style={{ ...gitBtnStyle, borderColor: showGitPanel ? "var(--j-accent)" : "var(--j-border)" }}
              >
                <span style={{ fontSize: "13px" }}>&#9745;</span>
                {activeProject.gitBranch}
                {activeProject.gitDirty && <span style={{ color: "var(--j-warning)", fontSize: "10px" }}>*</span>}
              </button>
            )}
            {activeProject.githubUrl && (
              <a
                href={activeProject.githubUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={ghIndicatorStyle}
                title={`View on GitHub: ${activeProject.githubUrl.replace("https://github.com/", "")}`}
              >
                GH
              </a>
            )}
            {activeProject.status === "running" && (
              <button onClick={onStopServer} style={stopBtnStyle} title="Stop dev server">
                Stop
              </button>
            )}
            {activeProject.status === "starting" && (
              <span style={{ fontSize: "11px", color: "var(--j-warning)" }}>Starting...</span>
            )}
          </>
        )}
        <button onClick={onNewProject} style={newProjectBtnStyle}>New Project</button>
      </div>

      {/* Git panel dropdown */}
      {showGitPanel && activeProjectId && activeProject && (
        <SiteGitPanel
          projectId={activeProjectId}
          projectName={activeProject.name}
          githubUrl={activeProject.githubUrl}
          onClose={() => setShowGitPanel(false)}
          onGitHubChange={onGitHubChange}
        />
      )}
    </div>
  );
}

const barStyle: React.CSSProperties = {
  position: "relative",
  display: "flex",
  alignItems: "center",
  height: 38,
  background: "var(--j-bg)",
  borderBottom: "1px solid var(--j-border)",
  padding: "0 8px",
  gap: "4px",
};

const tabStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "6px",
  padding: "4px 10px",
  borderRadius: "4px 4px 0 0",
  cursor: "pointer",
  maxWidth: 180,
  color: "var(--j-text-dim)",
};

const closeBtnStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "var(--j-text-muted)",
  cursor: "pointer",
  fontSize: "11px",
  padding: "0 2px",
  marginLeft: "4px",
  lineHeight: 1,
};

const addTabStyle: React.CSSProperties = {
  background: "none",
  border: "1px solid var(--j-border)",
  borderRadius: "4px",
  color: "var(--j-text-muted)",
  cursor: "pointer",
  fontSize: "14px",
  width: 24,
  height: 24,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const dropdownStyle: React.CSSProperties = {
  position: "absolute",
  top: "100%",
  left: 0,
  marginTop: "4px",
  background: "var(--j-surface)",
  border: "1px solid var(--j-border)",
  borderRadius: "6px",
  minWidth: 200,
  zIndex: 100,
  padding: "4px",
  boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
};

const dropdownItemStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "8px",
  width: "100%",
  padding: "6px 12px",
  background: "none",
  border: "none",
  borderRadius: "4px",
  color: "var(--j-text)",
  fontSize: "12px",
  cursor: "pointer",
  textAlign: "left",
};

const gitBtnStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "4px",
  padding: "2px 8px",
  fontSize: "11px",
  background: "none",
  border: "1px solid var(--j-border)",
  borderRadius: "4px",
  color: "var(--j-text-dim)",
  cursor: "pointer",
};

const ghIndicatorStyle: React.CSSProperties = {
  padding: "2px 6px",
  fontSize: "10px",
  fontWeight: 700,
  background: "rgba(0,212,255,0.1)",
  border: "1px solid rgba(0,212,255,0.3)",
  borderRadius: "4px",
  color: "var(--j-accent)",
  textDecoration: "none",
  cursor: "pointer",
};

const stopBtnStyle: React.CSSProperties = {
  padding: "2px 10px",
  fontSize: "11px",
  background: "rgba(239, 68, 68, 0.15)",
  border: "1px solid rgba(239, 68, 68, 0.3)",
  borderRadius: "4px",
  color: "var(--j-error)",
  cursor: "pointer",
};

const newProjectBtnStyle: React.CSSProperties = {
  padding: "4px 12px",
  fontSize: "11px",
  background: "rgba(0, 212, 255, 0.1)",
  border: "1px solid rgba(0, 212, 255, 0.3)",
  borderRadius: "4px",
  color: "var(--j-accent)",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

function statusDot(status: string): React.CSSProperties {
  const colors: Record<string, string> = {
    running: "var(--j-success)",
    starting: "var(--j-warning)",
    error: "var(--j-error)",
    stopped: "var(--j-text-muted)",
  };
  return {
    width: 6,
    height: 6,
    borderRadius: "50%",
    background: colors[status] ?? colors.stopped!,
    flexShrink: 0,
  };
}

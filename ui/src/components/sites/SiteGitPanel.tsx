import React, { useState, useEffect, useCallback } from "react";
import { api } from "../../hooks/useApi";
import type { GitBranch, GitCommit } from "../../pages/SitesPage";
import { SiteGitHubModal } from "./SiteGitHubModal";

type GitRemoteStatus = {
  hasRemote: boolean;
  remoteUrl: string | null;
  owner: string | null;
  repo: string | null;
  ahead: number;
  behind: number;
  lastPushedAt: number | null;
};

type Props = {
  projectId: string;
  projectName: string;
  githubUrl: string | null;
  onClose: () => void;
  onGitHubChange: () => void;
};

export function SiteGitPanel({ projectId, projectName, githubUrl, onClose, onGitHubChange }: Props) {
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [loading, setLoading] = useState(true);
  const [newBranchName, setNewBranchName] = useState("");
  const [showNewBranch, setShowNewBranch] = useState(false);
  const [mergeBranch, setMergeBranch] = useState<string | null>(null);
  const [mergeStrategy, setMergeStrategy] = useState<"merge" | "rebase">("merge");
  const [actionMessage, setActionMessage] = useState<{ text: string; type: "ok" | "error" } | null>(null);

  // GitHub state
  const [showGitHubModal, setShowGitHubModal] = useState(false);
  const [remoteStatus, setRemoteStatus] = useState<GitRemoteStatus | null>(null);
  const [pushing, setPushing] = useState(false);
  const [pulling, setPulling] = useState(false);

  const currentBranch = branches.find((b) => b.current)?.name ?? "main";

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [b, c] = await Promise.all([
        api<GitBranch[]>(`/api/sites/projects/${projectId}/git/branches`),
        api<GitCommit[]>(`/api/sites/projects/${projectId}/git/log?limit=30`),
      ]);
      setBranches(b);
      setCommits(c);
    } catch { /* ignore */ }
    setLoading(false);
  }, [projectId]);

  useEffect(() => { refresh(); }, [refresh]);

  const handleSwitchBranch = async (name: string) => {
    try {
      await api(`/api/sites/projects/${projectId}/git/branch`, {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      setActionMessage({ text: `Switched to ${name}`, type: "ok" });
      refresh();
    } catch (err) {
      setActionMessage({ text: err instanceof Error ? err.message : "Switch failed", type: "error" });
    }
  };

  const handleCreateBranch = async () => {
    if (!newBranchName.trim()) return;
    try {
      await api(`/api/sites/projects/${projectId}/git/branches`, {
        method: "POST",
        body: JSON.stringify({ name: newBranchName.trim() }),
      });
      setNewBranchName("");
      setShowNewBranch(false);
      setActionMessage({ text: `Created branch ${newBranchName}`, type: "ok" });
      refresh();
    } catch (err) {
      setActionMessage({ text: err instanceof Error ? err.message : "Create failed", type: "error" });
    }
  };

  const handleMerge = async () => {
    if (!mergeBranch) return;
    try {
      const result = await api<{ success: boolean; conflicts?: string[] }>(`/api/sites/projects/${projectId}/git/merge`, {
        method: "POST",
        body: JSON.stringify({ branch: mergeBranch, strategy: mergeStrategy }),
      });
      if (result.success) {
        setActionMessage({ text: `${mergeStrategy === "merge" ? "Merged" : "Rebased"} ${mergeBranch}`, type: "ok" });
      } else {
        setActionMessage({ text: `Conflicts in: ${result.conflicts?.join(", ")}`, type: "error" });
      }
      setMergeBranch(null);
      refresh();
    } catch (err) {
      setActionMessage({ text: err instanceof Error ? err.message : "Merge failed", type: "error" });
    }
  };

  // Fetch remote status when panel opens and project has GitHub
  useEffect(() => {
    if (!githubUrl) return;
    (async () => {
      try {
        const status = await api<GitRemoteStatus>(`/api/sites/projects/${projectId}/github/status`);
        setRemoteStatus(status);
      } catch { /* ignore */ }
    })();
  }, [projectId, githubUrl]);

  const handlePush = async () => {
    setPushing(true);
    setActionMessage(null);
    try {
      await api(`/api/sites/projects/${projectId}/github/push`, { method: "POST" });
      setActionMessage({ text: "Pushed to GitHub", type: "ok" });
      // Refresh status
      const status = await api<GitRemoteStatus>(`/api/sites/projects/${projectId}/github/status`);
      setRemoteStatus(status);
    } catch (err) {
      setActionMessage({ text: err instanceof Error ? err.message : "Push failed", type: "error" });
    }
    setPushing(false);
  };

  const handlePull = async () => {
    setPulling(true);
    setActionMessage(null);
    try {
      const result = await api<{ success: boolean; conflicts?: string[]; error?: string }>(
        `/api/sites/projects/${projectId}/github/pull`, { method: "POST" }
      );
      if (result.success) {
        setActionMessage({ text: "Pulled from GitHub", type: "ok" });
      } else if (result.conflicts?.length) {
        setActionMessage({ text: `Conflicts: ${result.conflicts.join(", ")}`, type: "error" });
      } else {
        setActionMessage({ text: result.error ?? "Pull failed", type: "error" });
      }
      refresh();
      const status = await api<GitRemoteStatus>(`/api/sites/projects/${projectId}/github/status`);
      setRemoteStatus(status);
    } catch (err) {
      setActionMessage({ text: err instanceof Error ? err.message : "Pull failed", type: "error" });
    }
    setPulling(false);
  };

  const handleDisconnect = async () => {
    if (!confirm("Disconnect this project from GitHub? (The remote repo will not be deleted.)")) return;
    try {
      await api(`/api/sites/projects/${projectId}/github/repo`, { method: "DELETE" });
      setRemoteStatus(null);
      setActionMessage({ text: "Disconnected from GitHub", type: "ok" });
      onGitHubChange();
    } catch (err) {
      setActionMessage({ text: err instanceof Error ? err.message : "Disconnect failed", type: "error" });
    }
  };

  return (
    <div style={panelStyle}>
      <div style={headerStyle}>
        <span style={{ fontWeight: 600, fontSize: "13px" }}>Git</span>
        <button onClick={onClose} style={closeBtnStyle}>x</button>
      </div>

      {actionMessage && (
        <div style={{
          padding: "6px 10px", margin: "0 8px 8px", borderRadius: "4px", fontSize: "11px",
          background: actionMessage.type === "ok" ? "rgba(16,185,129,0.1)" : "rgba(239,68,68,0.1)",
          color: actionMessage.type === "ok" ? "var(--j-success)" : "var(--j-error)",
        }}>
          {actionMessage.text}
        </div>
      )}

      {/* Branches */}
      <div style={sectionStyle}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
          <span style={sectionLabelStyle}>Branches</span>
          <button onClick={() => setShowNewBranch(!showNewBranch)} style={smallBtnStyle}>+ New</button>
        </div>

        {showNewBranch && (
          <div style={{ display: "flex", gap: "4px", marginBottom: 6 }}>
            <input
              type="text"
              value={newBranchName}
              onChange={(e) => setNewBranchName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleCreateBranch(); }}
              placeholder="branch-name"
              style={inputStyle}
              autoFocus
            />
            <button onClick={handleCreateBranch} style={smallBtnStyle}>Create</button>
          </div>
        )}

        {loading ? (
          <div style={{ fontSize: "11px", color: "var(--j-text-muted)", padding: "4px 0" }}>Loading...</div>
        ) : (
          branches.map((b) => (
            <div
              key={b.name}
              onClick={() => !b.current && handleSwitchBranch(b.name)}
              style={{
                ...branchItemStyle,
                fontWeight: b.current ? 600 : 400,
                color: b.current ? "var(--j-accent)" : "var(--j-text-dim)",
                cursor: b.current ? "default" : "pointer",
              }}
            >
              <span>{b.current ? "* " : "  "}{b.name}</span>
              {!b.current && (
                <button
                  onClick={(e) => { e.stopPropagation(); setMergeBranch(b.name); }}
                  style={{ ...smallBtnStyle, fontSize: "10px", padding: "1px 6px" }}
                >
                  Merge
                </button>
              )}
            </div>
          ))
        )}
      </div>

      {/* Merge dialog */}
      {mergeBranch && (
        <div style={{ ...sectionStyle, background: "rgba(0,212,255,0.05)", border: "1px solid rgba(0,212,255,0.2)", borderRadius: "4px", margin: "0 8px 8px" }}>
          <div style={{ fontSize: "11px", marginBottom: 6, color: "var(--j-text)" }}>
            Merge <strong>{mergeBranch}</strong> into <strong>{currentBranch}</strong>
          </div>
          <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
            <select
              value={mergeStrategy}
              onChange={(e) => setMergeStrategy(e.target.value as "merge" | "rebase")}
              style={{ ...inputStyle, flex: "none", width: 80 }}
            >
              <option value="merge">Merge</option>
              <option value="rebase">Rebase</option>
            </select>
            <button onClick={handleMerge} style={smallBtnStyle}>Confirm</button>
            <button onClick={() => setMergeBranch(null)} style={{ ...smallBtnStyle, color: "var(--j-text-muted)" }}>Cancel</button>
          </div>
        </div>
      )}

      {/* Commit log */}
      <div style={sectionStyle}>
        <span style={sectionLabelStyle}>Commits</span>
        <div style={{ maxHeight: 300, overflow: "auto", marginTop: 4 }}>
          {commits.map((c) => (
            <div key={c.hash} style={commitStyle} title={`${c.hash}\n${c.author}\n${new Date(c.date).toLocaleString()}`}>
              <span style={{ color: "var(--j-accent)", fontSize: "10px", fontFamily: "monospace", marginRight: 6 }}>
                {c.shortHash}
              </span>
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {c.message}
              </span>
              <span style={{ fontSize: "10px", color: "var(--j-text-muted)", marginLeft: 8, whiteSpace: "nowrap" }}>
                {formatRelativeDate(c.date)}
              </span>
            </div>
          ))}
          {commits.length === 0 && !loading && (
            <div style={{ fontSize: "11px", color: "var(--j-text-muted)", padding: "4px 0" }}>No commits yet</div>
          )}
        </div>
      </div>

      {/* GitHub section */}
      <div style={{ ...sectionStyle, borderTop: "1px solid var(--j-border)" }}>
        <span style={sectionLabelStyle}>GitHub</span>
        {githubUrl ? (
          <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: "6px" }}>
            <a href={githubUrl} target="_blank" rel="noopener noreferrer" style={ghLinkStyle}>
              {githubUrl.replace("https://github.com/", "")}
            </a>
            {remoteStatus && (
              <div style={{ display: "flex", gap: "8px", fontSize: "11px" }}>
                {remoteStatus.ahead > 0 && (
                  <span style={{ color: "var(--j-accent)" }}>{remoteStatus.ahead} ahead</span>
                )}
                {remoteStatus.behind > 0 && (
                  <span style={{ color: "var(--j-warning)" }}>{remoteStatus.behind} behind</span>
                )}
                {remoteStatus.ahead === 0 && remoteStatus.behind === 0 && (
                  <span style={{ color: "var(--j-text-muted)" }}>Up to date</span>
                )}
              </div>
            )}
            <div style={{ display: "flex", gap: "4px", marginTop: 2 }}>
              <button onClick={handlePush} disabled={pushing} style={smallBtnStyle}>
                {pushing ? "Pushing..." : "Push"}
              </button>
              <button onClick={handlePull} disabled={pulling} style={smallBtnStyle}>
                {pulling ? "Pulling..." : "Pull"}
              </button>
              <button onClick={handleDisconnect} style={{ ...smallBtnStyle, color: "var(--j-text-muted)", borderColor: "var(--j-border)", marginLeft: "auto" }}>
                Disconnect
              </button>
            </div>
          </div>
        ) : (
          <div style={{ marginTop: 6 }}>
            <button onClick={() => setShowGitHubModal(true)} style={smallBtnStyle}>
              Push to GitHub
            </button>
          </div>
        )}
      </div>

      {/* GitHub modal */}
      {showGitHubModal && (
        <SiteGitHubModal
          projectId={projectId}
          projectName={projectName}
          onClose={() => setShowGitHubModal(false)}
          onConnected={() => {
            setShowGitHubModal(false);
            onGitHubChange();
          }}
        />
      )}
    </div>
  );
}

function formatRelativeDate(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return `${Math.floor(diff / 86400_000)}d ago`;
}

const panelStyle: React.CSSProperties = {
  position: "absolute",
  top: 38,
  right: 8,
  width: 340,
  maxHeight: "70vh",
  background: "var(--j-surface)",
  border: "1px solid var(--j-border)",
  borderRadius: "8px",
  zIndex: 100,
  overflow: "auto",
  boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "10px 12px",
  borderBottom: "1px solid var(--j-border)",
};

const closeBtnStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "var(--j-text-muted)",
  cursor: "pointer",
  fontSize: "14px",
};

const sectionStyle: React.CSSProperties = {
  padding: "8px 12px",
};

const sectionLabelStyle: React.CSSProperties = {
  fontSize: "10px",
  fontWeight: 600,
  color: "var(--j-text-muted)",
  textTransform: "uppercase",
  letterSpacing: "0.5px",
};

const smallBtnStyle: React.CSSProperties = {
  padding: "2px 8px",
  fontSize: "11px",
  background: "rgba(0,212,255,0.1)",
  border: "1px solid rgba(0,212,255,0.3)",
  borderRadius: "3px",
  color: "var(--j-accent)",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const inputStyle: React.CSSProperties = {
  flex: 1,
  padding: "4px 8px",
  fontSize: "12px",
  background: "var(--j-bg)",
  border: "1px solid var(--j-border)",
  borderRadius: "3px",
  color: "var(--j-text)",
  outline: "none",
};

const branchItemStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "3px 4px",
  fontSize: "12px",
  borderRadius: "3px",
};

const commitStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  padding: "4px 0",
  fontSize: "11px",
  color: "var(--j-text-dim)",
  borderBottom: "1px solid var(--j-border)",
};

const ghLinkStyle: React.CSSProperties = {
  fontSize: "12px",
  color: "var(--j-accent)",
  textDecoration: "none",
  fontFamily: "monospace",
};

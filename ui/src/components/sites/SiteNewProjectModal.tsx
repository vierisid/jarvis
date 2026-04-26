import React, { useState, useEffect } from "react";
import { api } from "../../hooks/useApi";
import type { Project } from "./types";

type Template = {
  id: string;
  name: string;
  description: string;
  framework: string;
};

type GitCheck = {
  installed: boolean;
  authorName: string | null;
  authorEmail: string | null;
};

type Props = {
  onClose: () => void;
  onCreated: (project: Project) => void;
};

export function SiteNewProjectModal({ onClose, onCreated }: Props) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [name, setName] = useState("");
  const [selectedTemplate, setSelectedTemplate] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Git status
  const [gitCheck, setGitCheck] = useState<GitCheck | null>(null);
  const [gitName, setGitName] = useState("");
  const [gitEmail, setGitEmail] = useState("");
  const [gitGlobal, setGitGlobal] = useState(true);

  useEffect(() => {
    api<Template[]>("/api/sites/templates")
      .then((t) => {
        setTemplates(t);
        if (t.length > 0) setSelectedTemplate(t[0]!.id);
      })
      .catch(() => setTemplates([]));

    api<GitCheck>("/api/sites/git/check")
      .then((check) => {
        setGitCheck(check);
        if (check.authorName) setGitName(check.authorName);
        if (check.authorEmail) setGitEmail(check.authorEmail);
      })
      .catch(() => setGitCheck({ installed: false, authorName: null, authorEmail: null }));
  }, []);

  const gitInstalled = gitCheck === null || gitCheck.installed;
  const canCreate = !!(name.trim() && selectedTemplate && gitInstalled && gitName.trim() && gitEmail.trim());

  const handleCreate = async () => {
    if (!canCreate) return;
    setCreating(true);
    setError(null);
    try {
      const project = await api<Project>("/api/sites/projects", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          template: selectedTemplate,
          gitAuthor: { name: gitName.trim(), email: gitEmail.trim(), global: gitGlobal },
        }),
      });
      onCreated(project);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create project");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ fontSize: "14px", fontWeight: 600, color: "var(--j-text)", marginBottom: "16px" }}>
          New Project
        </h3>

        {/* Git not installed warning */}
        {gitCheck !== null && !gitCheck.installed && (
          <div style={warningBoxStyle}>
            <strong>Git is not installed.</strong> Git is required to create projects.
            Please install git and try again.
          </div>
        )}

        {/* Project name */}
        <div style={{ marginBottom: "12px" }}>
          <label style={labelStyle}>Project Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="my-awesome-site"
            style={inputStyle}
            autoFocus
            disabled={gitCheck !== null && !gitCheck.installed}
            onKeyDown={(e) => { if (e.key === "Enter") handleCreate(); }}
          />
        </div>

        {/* Template selection */}
        <div style={{ marginBottom: "16px" }}>
          <label style={labelStyle}>Template</label>
          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            {templates.map((t) => (
              <label
                key={t.id}
                style={{
                  ...templateOptionStyle,
                  borderColor: selectedTemplate === t.id ? "var(--j-accent)" : "var(--j-border)",
                  background: selectedTemplate === t.id ? "rgba(0, 212, 255, 0.05)" : "var(--j-surface)",
                  opacity: gitCheck !== null && !gitCheck.installed ? 0.5 : 1,
                  pointerEvents: gitCheck !== null && !gitCheck.installed ? "none" : "auto",
                }}
              >
                <input
                  type="radio"
                  name="template"
                  value={t.id}
                  checked={selectedTemplate === t.id}
                  onChange={() => setSelectedTemplate(t.id)}
                  style={{ display: "none" }}
                />
                <div>
                  <div style={{ fontSize: "12px", fontWeight: 600, color: "var(--j-text)" }}>{t.name}</div>
                  <div style={{ fontSize: "11px", color: "var(--j-text-muted)" }}>{t.description}</div>
                </div>
              </label>
            ))}
          </div>
        </div>

        {/* Git author config — always shown when git is available */}
        {gitCheck !== null && gitCheck.installed && (
          <div style={{ marginBottom: "16px" }}>
            <label style={labelStyle}>Git Author</label>
            <div style={{ display: "flex", gap: "8px", marginBottom: "8px" }}>
              <input
                type="text"
                value={gitName}
                onChange={(e) => setGitName(e.target.value)}
                placeholder="Name"
                style={inputStyle}
              />
              <input
                type="email"
                value={gitEmail}
                onChange={(e) => setGitEmail(e.target.value)}
                placeholder="Email"
                style={inputStyle}
              />
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "11px", color: "var(--j-text-dim)", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={gitGlobal}
                onChange={(e) => setGitGlobal(e.target.checked)}
                style={{ accentColor: "var(--j-accent)" }}
              />
              Set as global git config
            </label>
          </div>
        )}

        {/* Error */}
        {error && (
          <div style={{ padding: "8px", marginBottom: "12px", borderRadius: "4px", fontSize: "12px", background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.3)", color: "var(--j-error)" }}>
            {error}
          </div>
        )}

        {/* Actions */}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
          <button onClick={onClose} style={cancelBtnStyle}>Cancel</button>
          <button
            onClick={handleCreate}
            disabled={!canCreate || creating}
            style={{ ...createBtnStyle, opacity: canCreate ? 1 : 0.4 }}
          >
            {creating ? "Creating..." : "Create Project"}
          </button>
        </div>
      </div>
    </div>
  );
}

const overlayStyle: React.CSSProperties = {
  position: "fixed",
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  background: "rgba(0,0,0,0.6)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
};

const modalStyle: React.CSSProperties = {
  background: "var(--j-bg)",
  border: "1px solid var(--j-border)",
  borderRadius: "8px",
  padding: "20px",
  width: 420,
  maxWidth: "90vw",
  maxHeight: "80vh",
  overflow: "auto",
};

const labelStyle: React.CSSProperties = {
  fontSize: "11px",
  fontWeight: 600,
  color: "var(--j-text-muted)",
  textTransform: "uppercase",
  letterSpacing: "0.5px",
  marginBottom: "6px",
  display: "block",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  fontSize: "13px",
  background: "var(--j-surface)",
  border: "1px solid var(--j-border)",
  borderRadius: "4px",
  color: "var(--j-text)",
  outline: "none",
  boxSizing: "border-box",
};

const templateOptionStyle: React.CSSProperties = {
  padding: "10px 12px",
  border: "1px solid var(--j-border)",
  borderRadius: "6px",
  cursor: "pointer",
  transition: "border-color 0.15s",
};

const warningBoxStyle: React.CSSProperties = {
  padding: "10px 12px",
  marginBottom: "16px",
  borderRadius: "6px",
  fontSize: "12px",
  background: "rgba(239,68,68,0.1)",
  border: "1px solid rgba(239,68,68,0.3)",
  color: "var(--j-error, #ef4444)",
  lineHeight: 1.5,
};

const cancelBtnStyle: React.CSSProperties = {
  padding: "6px 16px",
  fontSize: "12px",
  background: "none",
  border: "1px solid var(--j-border)",
  borderRadius: "4px",
  color: "var(--j-text-dim)",
  cursor: "pointer",
};

const createBtnStyle: React.CSSProperties = {
  padding: "6px 16px",
  fontSize: "12px",
  fontWeight: 600,
  background: "rgba(0, 212, 255, 0.15)",
  border: "1px solid rgba(0, 212, 255, 0.4)",
  borderRadius: "4px",
  color: "var(--j-accent)",
  cursor: "pointer",
};

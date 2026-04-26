import React, { useState, useEffect } from "react";
import { api } from "../../hooks/useApi";
import type { FileEntry } from "./types";

type Props = {
  projectId: string | null;
  onFileSelect: (path: string) => void;
};

export function SiteFileTree({ projectId, onFileSelect }: Props) {
  const [tree, setTree] = useState<FileEntry | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set(["."]));

  useEffect(() => {
    if (!projectId) { setTree(null); return; }
    setLoading(true);
    api<FileEntry>(`/api/sites/projects/${projectId}/files`)
      .then(setTree)
      .catch(() => setTree(null))
      .finally(() => setLoading(false));
  }, [projectId]);

  const toggleDir = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  if (!projectId) return <div style={emptyStyle}>Select a project</div>;
  if (loading) return <div style={emptyStyle}>Loading files...</div>;
  if (!tree) return <div style={emptyStyle}>No files found</div>;

  return (
    <div style={{ padding: "4px 0", fontSize: "12px" }}>
      {tree.children?.map((entry) => (
        <FileNode
          key={entry.path}
          entry={entry}
          depth={0}
          expanded={expanded}
          onToggle={toggleDir}
          onSelect={onFileSelect}
        />
      ))}
    </div>
  );
}

function FileNode({ entry, depth, expanded, onToggle, onSelect }: {
  entry: FileEntry;
  depth: number;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
}) {
  const isDir = entry.type === "directory";
  const isOpen = expanded.has(entry.path);

  return (
    <>
      <div
        onClick={() => isDir ? onToggle(entry.path) : onSelect(entry.path)}
        style={{
          ...itemStyle,
          paddingLeft: 8 + depth * 14,
          cursor: "pointer",
        }}
        title={entry.path}
      >
        <span style={{ width: 14, textAlign: "center", fontSize: "10px", color: "var(--j-text-muted)" }}>
          {isDir ? (isOpen ? "▼" : "▶") : ""}
        </span>
        <span style={{ marginLeft: 4, color: isDir ? "var(--j-text-dim)" : "var(--j-text)" }}>
          {entry.name}
        </span>
      </div>
      {isDir && isOpen && entry.children?.map((child) => (
        <FileNode
          key={child.path}
          entry={child}
          depth={depth + 1}
          expanded={expanded}
          onToggle={onToggle}
          onSelect={onSelect}
        />
      ))}
    </>
  );
}

const itemStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  padding: "3px 8px",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const emptyStyle: React.CSSProperties = {
  color: "var(--j-text-muted)",
  fontSize: "12px",
  textAlign: "center",
  padding: "20px",
};

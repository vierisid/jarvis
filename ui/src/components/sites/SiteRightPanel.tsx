import React from "react";
import { SitePreview } from "./SitePreview";
import { SiteEditor } from "./SiteEditor";
import type { Project } from "./types";

type Props = {
  rightTab: "preview" | "editor";
  setRightTab: (tab: "preview" | "editor") => void;
  project: Project | null;
  openFilePath: string | null;
};

export function SiteRightPanel({ rightTab, setRightTab, project, openFilePath }: Props) {
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Tab bar */}
      <div style={tabBarStyle}>
        <button
          onClick={() => setRightTab("preview")}
          style={rightTab === "preview" ? activeTabBtnStyle : tabBtnStyle}
        >
          Preview
        </button>
        <button
          onClick={() => setRightTab("editor")}
          style={rightTab === "editor" ? activeTabBtnStyle : tabBtnStyle}
        >
          Editor
          {openFilePath && (
            <span style={{ marginLeft: 6, fontSize: "10px", color: "var(--ink3)", fontWeight: 400 }}>
              {openFilePath.split("/").pop()}
            </span>
          )}
        </button>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: "hidden" }}>
        {rightTab === "preview" ? (
          <SitePreview project={project} />
        ) : (
          <SiteEditor projectId={project?.id ?? null} filePath={openFilePath} />
        )}
      </div>
    </div>
  );
}

const tabBarStyle: React.CSSProperties = {
  display: "flex",
  borderBottom: "1px solid var(--rule)",
  background: "var(--bg)",
};

const tabBtnStyle: React.CSSProperties = {
  padding: "8px 16px",
  background: "none",
  border: "none",
  borderBottom: "2px solid transparent",
  color: "var(--ink3)",
  fontSize: "12px",
  fontWeight: 600,
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
};

const activeTabBtnStyle: React.CSSProperties = {
  ...tabBtnStyle,
  color: "var(--ink)",
  borderBottom: "2px solid var(--ink)",
};

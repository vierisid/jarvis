import React, { useState } from "react";
import type { Project } from "../../pages/SitesPage";

type Props = {
  project: Project | null;
};

export function SitePreview({ project }: Props) {
  const [iframeKey, setIframeKey] = useState(0);

  if (!project) {
    return <div style={emptyStyle}>Select a project to see the preview</div>;
  }

  if (project.status === "stopped") {
    return (
      <div style={emptyStyle}>
        <div style={{ fontSize: "14px", marginBottom: "8px" }}>Server is stopped</div>
        <div style={{ fontSize: "12px", color: "var(--j-text-muted)" }}>
          Open the project tab to auto-start the dev server
        </div>
      </div>
    );
  }

  if (project.status === "starting") {
    return (
      <div style={emptyStyle}>
        <div style={spinnerStyle} />
        <div style={{ fontSize: "12px", marginTop: "12px" }}>Starting dev server...</div>
      </div>
    );
  }

  if (project.status === "error") {
    return (
      <div style={{ ...emptyStyle, color: "var(--j-error)" }}>
        <div style={{ fontSize: "14px", marginBottom: "8px" }}>Server error</div>
        <div style={{ fontSize: "12px" }}>Check the logs for details</div>
      </div>
    );
  }

  // Initial load goes through the proxy, which sets a __proj cookie.
  // Subsequent requests (scripts, assets) use absolute paths like /src/main.tsx
  // which hit the main server's catch-all and get routed via the cookie.
  const previewUrl = `/api/sites/${project.id}/proxy/`;

  // allow-same-origin is required so that cookies, ES modules, and
  // framework features (HMR WebSockets, fetch) work correctly.
  const sandboxValue = "allow-scripts allow-forms allow-same-origin allow-popups";

  return (
    <div style={{ position: "relative", width: "100%", height: "100%", background: "#fff" }}>
      {/* Reload button */}
      <button
        onClick={() => setIframeKey((k) => k + 1)}
        style={reloadBtnStyle}
        title="Reload preview"
      >
        &#8635;
      </button>

      {/* URL bar */}
      <div style={urlBarStyle}>
        <span style={{ fontSize: "10px", color: "var(--j-text-muted)" }}>
          {previewUrl}
        </span>
      </div>

      <iframe
        key={iframeKey}
        src={previewUrl}
        sandbox={sandboxValue}
        style={{
          width: "100%",
          height: "calc(100% - 28px)",
          border: "none",
          background: "#fff",
        }}
        title={`Preview: ${project.name}`}
      />
    </div>
  );
}

const emptyStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  height: "100%",
  color: "var(--j-text-dim)",
  fontSize: "13px",
};

const reloadBtnStyle: React.CSSProperties = {
  position: "absolute",
  top: 4,
  right: 8,
  zIndex: 10,
  background: "rgba(0,0,0,0.6)",
  border: "none",
  borderRadius: "4px",
  color: "#fff",
  fontSize: "14px",
  width: 24,
  height: 24,
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const urlBarStyle: React.CSSProperties = {
  height: 28,
  display: "flex",
  alignItems: "center",
  padding: "0 10px",
  background: "var(--j-bg)",
  borderBottom: "1px solid var(--j-border)",
};

const spinnerStyle: React.CSSProperties = {
  width: 24,
  height: 24,
  border: "2px solid var(--j-border)",
  borderTop: "2px solid var(--j-accent)",
  borderRadius: "50%",
  animation: "spin 1s linear infinite",
};

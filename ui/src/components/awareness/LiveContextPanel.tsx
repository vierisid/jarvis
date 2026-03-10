import React, { useEffect, useRef } from "react";
import { useApiData } from "../../hooks/useApi";

type LiveContext = {
  currentApp: string | null;
  currentWindow: string | null;
  currentSession: { id: string; topic: string | null; durationMs: number } | null;
  recentApps: string[];
  capturesLastHour: number;
  suggestionsToday: number;
  isRunning: boolean;
};

type AwarenessStatus = {
  status: string;
  enabled: boolean;
  liveContext: LiveContext;
};

export function LiveContextPanel() {
  const { data, loading, refetch } = useApiData<AwarenessStatus>("/api/awareness/status", []);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Poll every 5 seconds for live context updates
  useEffect(() => {
    intervalRef.current = setInterval(refetch, 5000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [refetch]);

  if (loading || !data) {
    return (
      <div style={cardStyle}>
        <div style={headerStyle}>Live Context</div>
        <div style={{ color: "var(--j-text-muted)", fontSize: "13px", padding: "16px" }}>
          {loading ? "Loading..." : "Awareness service not available"}
        </div>
      </div>
    );
  }

  const ctx = data.liveContext;
  const sessionMinutes = ctx.currentSession
    ? Math.round(ctx.currentSession.durationMs / 60000)
    : 0;

  return (
    <div style={cardStyle}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", ...headerStyle }}>
        <span>Live Context</span>
        <StatusDot running={ctx.isRunning} />
      </div>

      <div style={{ padding: "12px 16px", display: "flex", flexDirection: "column", gap: "12px" }}>
        {/* Current App */}
        <div>
          <div style={labelStyle}>Current App</div>
          <div style={{ fontSize: "16px", fontWeight: 600, color: "var(--j-accent)" }}>
            {ctx.currentApp || "None"}
          </div>
          {ctx.currentWindow && (
            <div style={{ fontSize: "12px", color: "var(--j-text-muted)", marginTop: "2px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {ctx.currentWindow}
            </div>
          )}
        </div>

        {/* Session */}
        {ctx.currentSession && (
          <div>
            <div style={labelStyle}>Active Session</div>
            <div style={{ fontSize: "13px", color: "var(--j-text)" }}>
              {ctx.currentSession.topic || "Unnamed session"} ({sessionMinutes}m)
            </div>
          </div>
        )}

        {/* Recent Apps */}
        {ctx.recentApps.length > 0 && (
          <div>
            <div style={labelStyle}>Recent Apps (10m)</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "4px" }}>
              {ctx.recentApps.map((app) => (
                <span key={app} style={pillStyle}>{app}</span>
              ))}
            </div>
          </div>
        )}

        {/* Stats row */}
        <div style={{ display: "flex", gap: "16px", paddingTop: "8px", borderTop: "1px solid var(--j-border)" }}>
          <Stat label="Captures/hr" value={ctx.capturesLastHour} />
          <Stat label="Suggestions today" value={ctx.suggestionsToday} />
        </div>
      </div>
    </div>
  );
}

function StatusDot({ running }: { running: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "11px", color: "var(--j-text-muted)" }}>
      <span style={{
        width: "8px",
        height: "8px",
        borderRadius: "50%",
        background: running ? "var(--j-success)" : "var(--j-text-muted)",
        display: "inline-block",
        boxShadow: running ? "0 0 6px var(--j-success)" : "none",
      }} />
      {running ? "Active" : "Inactive"}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div style={{ fontSize: "18px", fontWeight: 600, color: "var(--j-text)" }}>{value}</div>
      <div style={{ fontSize: "11px", color: "var(--j-text-muted)" }}>{label}</div>
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  background: "var(--j-surface)",
  border: "1px solid var(--j-border)",
  borderRadius: "8px",
  overflow: "hidden",
};

const headerStyle: React.CSSProperties = {
  padding: "12px 16px",
  fontSize: "14px",
  fontWeight: 600,
  color: "var(--j-text)",
  borderBottom: "1px solid var(--j-border)",
};

const labelStyle: React.CSSProperties = {
  fontSize: "11px",
  color: "var(--j-text-muted)",
  textTransform: "uppercase",
  letterSpacing: "0.5px",
  marginBottom: "4px",
};

const pillStyle: React.CSSProperties = {
  padding: "2px 8px",
  borderRadius: "10px",
  background: "rgba(0, 212, 255, 0.1)",
  color: "var(--j-accent)",
  fontSize: "11px",
  fontWeight: 500,
};

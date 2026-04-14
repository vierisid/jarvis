import React, { useState, useEffect, useCallback } from "react";
import { api, useApiData } from "../hooks/useApi";
import { LiveContextPanel } from "../components/awareness/LiveContextPanel";
import { SuggestionPanel } from "../components/awareness/SuggestionPanel";
import { ActivityTimeline } from "../components/awareness/ActivityTimeline";
import { DailyReportPanel } from "../components/awareness/DailyReportPanel";
import { TrendsPanel } from "../components/awareness/TrendsPanel";
import "../styles/awareness.css";

type Tab = "live" | "timeline" | "reports" | "trends";

type AwarenessStatus = {
  status: string;
  enabled: boolean;
  liveContext: {
    currentApp: string | null;
    currentWindow: string | null;
    currentSession: { id: string; topic: string | null; durationMs: number } | null;
    recentApps: string[];
    capturesLastHour: number;
    suggestionsToday: number;
    isRunning: boolean;
  };
  usageEstimate: {
    capturesPerHour: number;
    estimatedVisionCallsPerHour: number;
    estimatedTokensPerHour: number;
    note: string;
  };
};

export default function AwarenessPage() {
  const [tab, setTab] = useState<Tab>("live");
  const [enabled, setEnabled] = useState(true);

  // Fetch awareness status for stats ribbon + toggle state
  const { data: status, refetch: refetchStatus } = useApiData<AwarenessStatus>(
    "/api/awareness/status", []
  );

  // Poll status every 5s
  useEffect(() => {
    const timer = setInterval(refetchStatus, 5000);
    return () => clearInterval(timer);
  }, [refetchStatus]);

  // Sync enabled state from API
  useEffect(() => {
    if (status) setEnabled(status.enabled);
  }, [status]);

  const handleToggle = useCallback(async () => {
    try {
      const res = await api<{ ok: boolean; enabled: boolean }>("/api/awareness/toggle", {
        method: "POST",
        body: JSON.stringify({ enabled: !enabled }),
      });
      setEnabled(res.enabled);
      refetchStatus();
    } catch (err) {
      console.error("Failed to toggle awareness:", err);
    }
  }, [enabled, refetchStatus]);

  const liveCtx = status?.liveContext;
  const isActive = status?.enabled && liveCtx?.isRunning;
  const currentApp = liveCtx?.currentApp || "—";
  const currentWindow = liveCtx?.currentWindow || "";
  const sessionTopic = liveCtx?.currentSession?.topic || null;
  const sessionMinutes = liveCtx?.currentSession ? Math.floor(liveCtx.currentSession.durationMs / 60000) : 0;
  const capturesHr = liveCtx?.capturesLastHour ?? 0;
  const suggestionsDay = liveCtx?.suggestionsToday ?? 0;
  const usageEstimate = status?.usageEstimate;

  return (
    <div className="aw-page">
      <div className="aw-atmosphere" />

      {/* Header */}
      <div className="aw-header">
        <span className="aw-header-title">Awareness</span>
        <span className={`aw-status-pill ${isActive ? "active" : "inactive"}`}>
          <span className={`aw-status-dot ${isActive ? "active" : "inactive"}`} />
          {isActive ? "Active" : enabled ? "Starting" : "Disabled"}
        </span>
        <div className="aw-header-spacer" />
        <button
          className={`aw-toggle-btn ${enabled ? "disable" : "enable"}`}
          onClick={handleToggle}
        >
          {enabled ? "Disable" : "Enable"}
        </button>
      </div>

      {/* Stats ribbon */}
      <div className="aw-stats-ribbon">
        <div className="aw-stat">
          <div className="aw-stat-label">Current App</div>
          <div className="aw-stat-value app-name" style={{ color: "#22D3EE" }}>{currentApp}</div>
          {currentWindow && <div className="aw-stat-sub">{currentWindow.length > 40 ? currentWindow.slice(0, 38) + ".." : currentWindow}</div>}
        </div>
        <div className="aw-stat">
          <div className="aw-stat-label">Captures / Hour</div>
          <div className="aw-stat-value" style={{ color: "#A78BFA" }}>{capturesHr}</div>
        </div>
        <div className="aw-stat">
          <div className="aw-stat-label">Suggestions Today</div>
          <div className="aw-stat-value" style={{ color: "#FBBF24" }}>{suggestionsDay}</div>
        </div>
        <div className="aw-stat">
          <div className="aw-stat-label">Estimated Tokens / Hour</div>
          <div className="aw-stat-value" style={{ color: "#34D399" }}>
            {enabled ? `~${(usageEstimate?.estimatedTokensPerHour ?? 0).toLocaleString()}` : "0"}
          </div>
          <div className="aw-stat-sub">
            {enabled
              ? `${usageEstimate?.estimatedVisionCallsPerHour ?? 0}/hr worst case`
              : "Enable awareness to estimate usage"}
          </div>
        </div>
        <div className="aw-stat">
          <div className="aw-stat-label">Session</div>
          <div className="aw-stat-value" style={{ color: "#22D3EE", fontSize: sessionTopic ? 14 : 20 }}>
            {sessionTopic || (sessionMinutes > 0 ? `${sessionMinutes}m` : "—")}
          </div>
          {sessionTopic && sessionMinutes > 0 && <div className="aw-stat-sub">{sessionMinutes}m active</div>}
        </div>
      </div>

      {usageEstimate ? (
        <div
          style={{
            marginTop: "14px",
            padding: "12px 14px",
            borderRadius: "12px",
            border: "1px solid rgba(52, 211, 153, 0.22)",
            background: "rgba(15, 118, 110, 0.18)",
            color: "rgba(255,255,255,0.86)",
            fontSize: "13px",
          }}
        >
          <strong style={{ color: "#A7F3D0" }}>Usage estimate</strong>{" "}
          Awareness samples about {usageEstimate.capturesPerHour}/hr and may escalate up to{" "}
          {usageEstimate.estimatedVisionCallsPerHour}/hr for cloud vision. {usageEstimate.note}
        </div>
      ) : null}

      {/* Tabs */}
      <div className="aw-tabs">
        <button className={`aw-tab-btn${tab === "live" ? " active" : ""}`} onClick={() => setTab("live")}>Live</button>
        <button className={`aw-tab-btn${tab === "timeline" ? " active" : ""}`} onClick={() => setTab("timeline")}>Timeline</button>
        <button className={`aw-tab-btn${tab === "reports" ? " active" : ""}`} onClick={() => setTab("reports")}>Reports</button>
        <button className={`aw-tab-btn${tab === "trends" ? " active" : ""}`} onClick={() => setTab("trends")}>Trends</button>
      </div>

      {/* Tab content */}
      <div className="aw-tab-content">
        {tab === "live" && (
          <div className="aw-live-split">
            <div><LiveContextPanel /></div>
            <div><SuggestionPanel /></div>
          </div>
        )}
        {tab === "timeline" && <ActivityTimeline />}
        {tab === "reports" && <DailyReportPanel />}
        {tab === "trends" && <TrendsPanel />}
      </div>
    </div>
  );
}

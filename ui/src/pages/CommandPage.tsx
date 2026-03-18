import React, { useMemo } from "react";
import { useApiData } from "../hooks/useApi";
import "../styles/command.css";

type HealthStatus = {
  uptime: number;
  services: Record<string, string>;
  memory: { heapUsed: number; heapTotal: number; rss: number };
  database: { connected: boolean; size: number };
  startedAt: number;
};

type AgentInfo = {
  id: string;
  status: string;
  role: { name: string };
};

type Observation = {
  id: string;
  type: string;
  data: Record<string, unknown>;
  processed: boolean;
  created_at: number;
};

const OBS_TYPE_COLORS: Record<string, string> = {
  file_change: "#22D3EE",
  notification: "#FBBF24",
  clipboard: "#A78BFA",
  app_activity: "#34D399",
  calendar: "#FBBF24",
  email: "#60A5FA",
  browser: "#A78BFA",
  process: "rgba(255,255,255,0.30)",
  screen_capture: "#22D3EE",
};

const OBS_TYPE_LABELS: Record<string, string> = {
  file_change: "file",
  notification: "notif",
  clipboard: "clip",
  app_activity: "app",
  calendar: "cal",
  email: "email",
  browser: "web",
  process: "proc",
  screen_capture: "screen",
};

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]!}`;
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return parts.join(" ");
}

function getStatusColor(status: string): string {
  if (status === "running") return "#34D399";
  if (status === "idle") return "#FBBF24";
  return "#FB7185";
}

function getStatusClass(status: string): string {
  if (status === "running") return "running";
  if (status === "idle") return "idle";
  return "stopped";
}

export default function CommandPage() {
  const { data: health, loading: healthLoading } = useApiData<HealthStatus>("/api/health", []);
  const { data: agents } = useApiData<AgentInfo[]>("/api/agents", []);
  const { data: observations, loading: obsLoading } = useApiData<Observation[]>("/api/vault/observations?limit=30", []);

  const activeAgents = agents?.filter(a => a.status === "active").length ?? 0;
  const totalAgents = agents?.length ?? 0;

  const memPercent = useMemo(() => {
    if (!health || health.memory.heapTotal === 0) return 0;
    return Math.round((health.memory.heapUsed / health.memory.heapTotal) * 100);
  }, [health]);

  // Determine overall system health
  const systemStatus = useMemo(() => {
    if (!health) return { label: "Loading", color: "rgba(255,255,255,0.30)" };
    const services = Object.values(health.services);
    const stoppedCount = services.filter(s => s !== "running" && s !== "idle").length;
    if (stoppedCount > 2 || memPercent > 90 || !health.database.connected) {
      return { label: "Critical", color: "#FB7185" };
    }
    if (stoppedCount > 0 || memPercent > 70) {
      return { label: "Degraded", color: "#FBBF24" };
    }
    return { label: "Healthy", color: "#34D399" };
  }, [health, memPercent]);

  const orbClass = systemStatus.label === "Critical" ? "critical" : systemStatus.label === "Degraded" ? "degraded" : "";

  if (healthLoading) {
    return (
      <div className="cmd-page">
        <div className="cmd-atmosphere" />
        <div className="cmd-header"><span className="cmd-header-title">Command Center</span></div>
        <div className="cmd-loading">
          <div className="cmd-loading-orb" />
          <div className="cmd-loading-text">Loading system status...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="cmd-page">
      <div className="cmd-atmosphere" />

      {/* Header */}
      <div className="cmd-header">
        <span className="cmd-header-title">Command Center</span>
        <div className="cmd-header-spacer" />
        <span className="cmd-header-pid">pid: {typeof process !== "undefined" ? "—" : "—"} · port: 3142</span>
      </div>

      {/* Pulse section */}
      <div className="cmd-pulse-section">
        {/* Left stats */}
        <div className="cmd-radial-stats">
          <div className="cmd-rs-card">
            <div className="cmd-rs-dot" style={{ background: "#34D399" }} />
            <div className="cmd-rs-info">
              <div className="cmd-rs-label">Uptime</div>
              <div className="cmd-rs-val" style={{ color: "#34D399" }}>{health ? formatUptime(health.uptime) : "—"}</div>
              {health && <div className="cmd-rs-sub">since {new Date(health.startedAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</div>}
            </div>
          </div>
          <div className="cmd-rs-card">
            <div className="cmd-rs-dot" style={{ background: "#22D3EE" }} />
            <div className="cmd-rs-info">
              <div className="cmd-rs-label">Memory</div>
              <div className="cmd-rs-val" style={{ color: "#22D3EE" }}>{health ? formatBytes(health.memory.heapUsed) : "—"}</div>
              {health && (
                <>
                  <div className="cmd-rs-sub">{memPercent}% of {formatBytes(health.memory.heapTotal)}</div>
                  <div className="cmd-mem-bar">
                    <div className="cmd-mem-fill" style={{ width: `${memPercent}%`, background: memPercent > 80 ? "#FB7185" : "#22D3EE" }} />
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Central orb */}
        <div className="cmd-central-orb">
          <div className={`cmd-co-inner ${orbClass}`} />
          <div className="cmd-co-ring cmd-co-ring-1" style={{ borderColor: `${systemStatus.color}25` }} />
          <div className="cmd-co-ring cmd-co-ring-2" style={{ borderColor: `${systemStatus.color}20` }} />
          <div className="cmd-co-ring cmd-co-ring-3" style={{ borderColor: `${systemStatus.color}15` }} />
          <div className="cmd-co-label" style={{ color: systemStatus.color }}>{systemStatus.label}</div>
        </div>

        {/* Right stats */}
        <div className="cmd-radial-stats">
          <div className="cmd-rs-card">
            <div className="cmd-rs-dot" style={{ background: "#8B5CF6" }} />
            <div className="cmd-rs-info">
              <div className="cmd-rs-label">Database</div>
              <div className="cmd-rs-val" style={{ color: "#A78BFA" }}>{health ? formatBytes(health.database.size) : "—"}</div>
              <div className="cmd-rs-sub">{health?.database.connected ? "SQLite connected" : "Disconnected"}</div>
            </div>
          </div>
          <div className="cmd-rs-card">
            <div className="cmd-rs-dot" style={{ background: "#FBBF24" }} />
            <div className="cmd-rs-info">
              <div className="cmd-rs-label">Agents</div>
              <div className="cmd-rs-val" style={{ color: "#FBBF24" }}>{activeAgents} / {totalAgents}</div>
              <div className="cmd-rs-sub">active of total</div>
            </div>
          </div>
        </div>
      </div>

      {/* Bottom split: Services + Observations */}
      <div className="cmd-bottom-split">
        {/* Services panel */}
        <div className="cmd-panel-card">
          <div className="cmd-pc-header" style={{ color: "#34D399" }}>
            Services
            {health && <span className="cmd-pc-count">{Object.keys(health.services).length}</span>}
          </div>
          <div className="cmd-pc-body">
            {health ? Object.entries(health.services).map(([name, status]) => (
              <div key={name} className="cmd-svc-item">
                <div className={`cmd-svc-dot ${getStatusClass(status)}`} />
                <span className="cmd-svc-name">{name}</span>
                <span className="cmd-svc-status" style={{ color: getStatusColor(status) }}>{status}</span>
              </div>
            )) : (
              <div className="cmd-empty">No service data</div>
            )}
          </div>
        </div>

        {/* Observations panel */}
        <div className="cmd-panel-card">
          <div className="cmd-pc-header" style={{ color: "#A78BFA" }}>
            Observations
            {observations && <span className="cmd-pc-count">{observations.length}</span>}
          </div>
          <div className="cmd-pc-body">
            {obsLoading && <div className="cmd-empty">Loading...</div>}
            {!obsLoading && (!observations || observations.length === 0) && (
              <div className="cmd-empty">No observations recorded yet</div>
            )}
            {observations?.map((obs, i) => {
              const color = OBS_TYPE_COLORS[obs.type] || "rgba(255,255,255,0.30)";
              const label = OBS_TYPE_LABELS[obs.type] || obs.type;
              return (
                <div key={obs.id} className="cmd-obs-item" style={{ animationDelay: `${i * 0.02}s` }}>
                  <span className="cmd-obs-type" style={{ background: `${color}20`, color }}>{label}</span>
                  <span className="cmd-obs-text">{JSON.stringify(obs.data).slice(0, 150)}</span>
                  <span className="cmd-obs-time">{new Date(obs.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

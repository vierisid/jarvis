import React, { useState, useEffect, useCallback, useRef } from "react";
import { api } from "../hooks/useApi";
import type { ChatMessage, AgentActivityEvent, GoalEvent, WorkflowEvent } from "../hooks/useWebSocket";
import type { UseVoiceReturn } from "../hooks/useVoice";
import "../styles/dashboard.css";

/* ================================================================
   TYPES — API response shapes
   ================================================================ */
type AgentInfo = {
  id: string;
  role: { id: string; name: string };
  status: "active" | "idle" | "terminated";
  current_task: string | null;
  created_at: number;
};

type HealthData = {
  uptime: number; // seconds
  services: Record<string, string>;
  memory: { heapUsed: number; heapTotal: number; rss: number };
  database: { connected: boolean; size: number };
  startedAt: number;
};

type VaultEntity = {
  id: string;
  type: string;
  name: string;
  description: string;
  created_at: number;
  updated_at: number;
};

type GoalData = {
  id: string;
  title: string;
  score: number;
  status: string;
  health: string;
  level: string;
  deadline: number | null;
};

type WorkflowData = {
  id: string;
  name: string;
  status: string;
};

/* ================================================================
   PROPS
   ================================================================ */
type DashboardProps = {
  messages: ChatMessage[];
  isConnected: boolean;
  voice: UseVoiceReturn;
  agentActivity: AgentActivityEvent[];
  goalEvents: GoalEvent[];
  workflowEvents: WorkflowEvent[];
};

/* ================================================================
   HELPERS
   ================================================================ */
function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  if (d > 0) return `${d}d ${h}h`;
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function timeAgo(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 10) return "just now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function formatSessionTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/* ================================================================
   ATMOSPHERE — Three-layer living background (unchanged)
   ================================================================ */
function Atmosphere() {
  return (
    <div className="db-atmosphere" aria-hidden="true">
      {/* Layer 1: Aurora */}
      <div className="db-aurora-layer" />

      {/* Layer 2: Constellation */}
      <div className="db-constellation-layer">
        {/* Cluster A: top-left entry zone */}
        <div className="db-const-node db-drift" style={{ width: 3, height: 3, background: "rgba(139,92,246,0.16)", top: "7%", left: "5%", "--dur": "14s", "--delay": "0s" } as React.CSSProperties} />
        <div className="db-const-node db-drift" style={{ width: 4, height: 4, background: "rgba(139,92,246,0.12)", top: "12%", left: "9%", "--dur": "19s", "--delay": "1.3s" } as React.CSSProperties} />
        <div className="db-const-node"           style={{ width: 2, height: 2, background: "rgba(96,165,250,0.10)", top: "5%", left: "14%" }} />
        <div className="db-const-node db-drift" style={{ width: 5, height: 5, background: "rgba(139,92,246,0.18)", top: "17%", left: "10%", "--dur": "23s", "--delay": "4.7s" } as React.CSSProperties} />

        {/* Diagonal scatter B */}
        <div className="db-const-node db-drift" style={{ width: 3, height: 3, background: "rgba(139,92,246,0.10)", top: "28%", left: "24%", "--dur": "28s", "--delay": "2.1s" } as React.CSSProperties} />
        <div className="db-const-node"           style={{ width: 2, height: 2, background: "rgba(139,92,246,0.08)", top: "35%", left: "37%" }} />
        <div className="db-const-node db-drift" style={{ width: 4, height: 4, background: "rgba(96,165,250,0.10)", top: "43%", left: "47%", "--dur": "33s", "--delay": "7.3s" } as React.CSSProperties} />
        <div className="db-const-node"           style={{ width: 2, height: 2, background: "rgba(139,92,246,0.12)", top: "52%", left: "56%" }} />

        {/* Cluster C: bottom-right */}
        <div className="db-const-node db-drift" style={{ width: 5, height: 5, background: "rgba(139,92,246,0.14)", top: "62%", left: "66%", "--dur": "41s", "--delay": "9.8s" } as React.CSSProperties} />
        <div className="db-const-node"           style={{ width: 2, height: 2, background: "rgba(52,211,153,0.06)", top: "70%", left: "73%" }} />
        <div className="db-const-node db-drift" style={{ width: 3, height: 3, background: "rgba(139,92,246,0.10)", top: "78%", left: "81%", "--dur": "22s", "--delay": "5.5s" } as React.CSSProperties} />
        <div className="db-const-node"           style={{ width: 2, height: 2, background: "rgba(139,92,246,0.08)", top: "86%", left: "89%" }} />

        {/* Scattered fill */}
        <div className="db-const-node"           style={{ width: 2, height: 2, background: "rgba(96,165,250,0.10)", top: "57%", left: "29%" }} />
        <div className="db-const-node db-drift" style={{ width: 3, height: 3, background: "rgba(139,92,246,0.09)", top: "74%", left: "43%", "--dur": "31s", "--delay": "11.2s" } as React.CSSProperties} />

        {/* SVG connector lines */}
        <svg className="db-const-svg" viewBox="0 0 1440 900" preserveAspectRatio="none">
          <line className="db-cl-idle" x1="72"  y1="63"  x2="130" y2="108" />
          <line className="db-cl-idle" x1="130" y1="108" x2="144" y2="153" />
          <line className="db-cl-flow" style={{ "--fp": "6s" } as React.CSSProperties}  x1="346" y1="252" x2="533" y2="315" />
          <line className="db-cl-flow" style={{ "--fp": "9s" } as React.CSSProperties}  x1="533" y1="315" x2="677" y2="387" />
          <line className="db-cl-flow" style={{ "--fp": "12s" } as React.CSSProperties} x1="677" y1="387" x2="806" y2="468" />
          <line className="db-cl-idle" x1="950" y1="558" x2="1051" y2="630" />
          <line className="db-cl-flow" style={{ "--fp": "15s" } as React.CSSProperties} x1="1051" y1="630" x2="1166" y2="702" />
          <line className="db-cl-idle" x1="144" y1="153" x2="950" y2="558" />
        </svg>
      </div>

      {/* Layer 3: Data Streams */}
      <div className="db-stream-channel" style={{ left: "18%" }}>
        <div className="db-stream-particle" style={{ background: "rgba(139,92,246,0.07)", "--dur": "22s", "--delay": "0s" } as React.CSSProperties} />
        <div className="db-stream-particle" style={{ background: "rgba(139,92,246,0.06)", "--dur": "18s", "--delay": "8s" } as React.CSSProperties} />
      </div>
      <div className="db-stream-channel" style={{ left: "38%" }}>
        <div className="db-stream-particle" style={{ background: "rgba(139,92,246,0.06)", "--dur": "28s", "--delay": "3s" } as React.CSSProperties} />
        <div className="db-stream-particle" style={{ background: "rgba(139,92,246,0.08)", "--dur": "20s", "--delay": "13s" } as React.CSSProperties} />
      </div>
      <div className="db-stream-channel" style={{ left: "62%" }}>
        <div className="db-stream-particle" style={{ background: "rgba(139,92,246,0.07)", "--dur": "25s", "--delay": "6s" } as React.CSSProperties} />
        <div className="db-stream-particle" style={{ background: "rgba(139,92,246,0.06)", "--dur": "30s", "--delay": "17s" } as React.CSSProperties} />
        <div className="db-stream-particle" style={{ background: "rgba(96,165,250,0.06)",  "--dur": "19s", "--delay": "22s" } as React.CSSProperties} />
      </div>
      <div className="db-stream-channel" style={{ left: "83%" }}>
        <div className="db-stream-particle" style={{ background: "rgba(139,92,246,0.07)", "--dur": "24s", "--delay": "11s" } as React.CSSProperties} />
        <div className="db-stream-particle" style={{ background: "rgba(139,92,246,0.06)", "--dur": "32s", "--delay": "4s" } as React.CSSProperties} />
      </div>
    </div>
  );
}

/* ================================================================
   METRIC CARD (unchanged)
   ================================================================ */
interface MetricCardProps {
  label: string;
  value: string;
  trend: string;
  trendType: "up" | "flat";
  fresh: string;
  cardDelay: string;
  lineDelay: string;
  sparklineStroke: string;
  sparklineLine: string;
  sparklineFillId: string;
  sparklineFillColor: string;
  sparklineFillPath: string;
  href?: string;
}

function MetricCard({
  label, value, trend, trendType, fresh,
  cardDelay, lineDelay,
  sparklineStroke, sparklineLine,
  sparklineFillId, sparklineFillColor, sparklineFillPath,
  href,
}: MetricCardProps) {
  return (
    <div
      className="db-metric-card"
      style={{ "--card-delay": cardDelay, cursor: href ? "pointer" : "default" } as React.CSSProperties}
      aria-label={`${label}: ${value}`}
      onClick={href ? () => { window.location.hash = href; } : undefined}
      role={href ? "link" : undefined}
      tabIndex={href ? 0 : undefined}
      onKeyDown={href ? (e) => { if (e.key === "Enter") window.location.hash = href; } : undefined}
    >
      <div className="db-metric-label">{label}</div>
      <div className="db-metric-value">{value}</div>
      <svg className="db-sparkline" viewBox="0 0 100 32" aria-hidden="true">
        <defs>
          <linearGradient id={sparklineFillId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={sparklineFillColor} />
            <stop offset="100%" stopColor="rgba(0,0,0,0)" />
          </linearGradient>
        </defs>
        <path className="db-fill" d={sparklineFillPath} fill={`url(#${sparklineFillId})`} />
        <path
          className="db-line"
          stroke={sparklineStroke}
          d={sparklineLine}
          style={{ "--line-delay": lineDelay } as React.CSSProperties}
        />
      </svg>
      <div className="db-metric-foot">
        <span className={`db-metric-trend ${trendType === "up" ? "db-trend-up" : "db-trend-flat"}`}>{trend}</span>
        <span className="db-metric-fresh">{fresh}</span>
      </div>
    </div>
  );
}

/* ================================================================
   PULSE CORE (unchanged)
   ================================================================ */
function PulseCore() {
  return (
    <div className="db-core-wrap" aria-label="JARVIS system core">
      <div className="db-core-container" role="img" aria-label="System pulse orb">
        <div className="db-core-ring db-core-ring-1" aria-hidden="true" />
        <div className="db-core-ring db-core-ring-2" aria-hidden="true" />
        <div className="db-core-ring db-core-ring-3" aria-hidden="true" />
        <div className="db-core-orb" aria-hidden="true" />
        <div className="db-orbital-wrap" aria-hidden="true">
          <div className="db-orbital-dot" style={{ "--r": "36px", "--speed": "14s", "--sz": "4px", "--col": "rgba(139,92,246,0.9)" } as React.CSSProperties} />
          <div className="db-orbital-dot" style={{ "--r": "52px", "--speed": "21s", "--sz": "3px", "--col": "rgba(52,211,153,0.9)" } as React.CSSProperties} />
          <div className="db-orbital-dot" style={{ "--r": "72px", "--speed": "31s", "--sz": "3px", "--col": "rgba(96,165,250,0.9)" } as React.CSSProperties} />
        </div>
      </div>
      <div className="db-core-label" aria-hidden="true">System Pulse</div>
    </div>
  );
}

/* ================================================================
   HERO ROW — wired to live metrics
   ================================================================ */
function HeroRow({ agents, health, entityCount, workflowCount }: {
  agents: AgentInfo[];
  health: HealthData | null;
  entityCount: number;
  workflowCount: number;
}) {
  const activeAgents = agents.filter(a => a.status === "active").length;
  const uptimeStr = health ? formatUptime(health.uptime) : "--";

  return (
    <div className="db-hero-row" aria-label="System overview">
      {/* Left metrics */}
      <div className="db-metrics-col">
        <MetricCard
          label="Active Agents"
          value={String(activeAgents)}
          trend={`${agents.length} total`}
          trendType={activeAgents > 0 ? "up" : "flat"}
          fresh="live"
          cardDelay="0ms"
          lineDelay="0ms"
          sparklineStroke="#8B5CF6"
          sparklineFillId="db-fillV"
          sparklineFillColor="rgba(139,92,246,0.14)"
          sparklineFillPath="M0,28 C10,26 18,24 28,22 C38,20 48,18 56,14 C64,10 74,8 84,6 C90,5 96,4 100,4 L100,32 L0,32 Z"
          sparklineLine="M0,28 C10,26 18,24 28,22 C38,20 48,18 56,14 C64,10 74,8 84,6 C90,5 96,4 100,4"
          href="#/office"
        />
        <MetricCard
          label="Workflows"
          value={String(workflowCount)}
          trend={workflowCount > 0 ? "active" : "none"}
          trendType={workflowCount > 0 ? "up" : "flat"}
          fresh="live"
          cardDelay="80ms"
          lineDelay="80ms"
          sparklineStroke="#60A5FA"
          sparklineFillId="db-fillB"
          sparklineFillColor="rgba(96,165,250,0.12)"
          sparklineFillPath="M0,24 C12,22 24,20 34,18 C44,16 52,16 60,14 C70,12 80,10 88,8 C92,7 96,6 100,5 L100,32 L0,32 Z"
          sparklineLine="M0,24 C12,22 24,20 34,18 C44,16 52,16 60,14 C70,12 80,10 88,8 C92,7 96,6 100,5"
          href="#/workflows"
        />
      </div>

      {/* Pulse Core center */}
      <PulseCore />

      {/* Right metrics */}
      <div className="db-metrics-col">
        <MetricCard
          label="Memory Entities"
          value={entityCount > 999 ? `${(entityCount / 1000).toFixed(1)}k` : String(entityCount)}
          trend={entityCount > 0 ? "indexed" : "empty"}
          trendType={entityCount > 0 ? "up" : "flat"}
          fresh="live"
          cardDelay="40ms"
          lineDelay="40ms"
          sparklineStroke="#34D399"
          sparklineFillId="db-fillE"
          sparklineFillColor="rgba(52,211,153,0.12)"
          sparklineFillPath="M0,26 C8,24 18,22 28,20 C38,18 46,16 56,13 C66,10 76,7 86,5 C92,4 96,4 100,3 L100,32 L0,32 Z"
          sparklineLine="M0,26 C8,24 18,22 28,20 C38,18 46,16 56,13 C66,10 76,7 86,5 C92,4 96,4 100,3"
          href="#/memory"
        />
        <MetricCard
          label="System Uptime"
          value={uptimeStr}
          trend={health ? `since ${new Date(health.startedAt).toLocaleDateString()}` : "--"}
          trendType="flat"
          fresh="live"
          cardDelay="120ms"
          lineDelay="120ms"
          sparklineStroke="#8B5CF6"
          sparklineFillId="db-fillU"
          sparklineFillColor="rgba(139,92,246,0.10)"
          sparklineFillPath="M0,15 C16,15 32,16 48,15 C64,14 80,15 100,15 L100,32 L0,32 Z"
          sparklineLine="M0,15 C16,15 32,16 48,15 C64,14 80,15 100,15"
          href="#/command"
        />
      </div>
    </div>
  );
}

/* ================================================================
   AGENT FLEET — wired to /api/agents
   ================================================================ */
interface AgentCardProps {
  status: "running" | "idle" | "error";
  name: string;
  role: string;
  task: string;
  meta: string;
  flowDelay?: string;
}

function AgentCard({ status, name, role, task, meta, flowDelay }: AgentCardProps) {
  const dotClass = status === "running"
    ? "db-s-running"
    : status === "error"
    ? "db-s-error"
    : "db-s-idle";

  return (
    <div
      className="db-agent-card"
      tabIndex={0}
      aria-label={`${name} agent, ${status}`}
      role="listitem"
      onClick={() => { window.location.hash = "#/office"; }}
      onKeyDown={(e) => { if (e.key === "Enter") window.location.hash = "#/office"; }}
    >
      <div className="db-agent-top">
        <div className={`db-status-dot ${dotClass}`} aria-hidden="true" />
        <span className="db-agent-name">{name}</span>
        <span className="db-agent-role">{role}</span>
      </div>
      <div className="db-agent-task">{task}</div>
      <div className="db-agent-meta">{meta}</div>
      {status === "running" && (
        <div className="db-agent-flow-bar" aria-hidden="true">
          <div
            className="db-agent-flow-slab"
            style={{ "--slab-delay": flowDelay ?? "0s" } as React.CSSProperties}
          />
        </div>
      )}
    </div>
  );
}

function AgentFleet({ agents }: { agents: AgentInfo[] }) {
  const cards: AgentCardProps[] = agents.map((a, i) => {
    const status: AgentCardProps["status"] =
      a.status === "active" ? "running"
      : a.status === "terminated" ? "error"
      : "idle";

    const elapsed = Math.floor((Date.now() - a.created_at) / 1000);
    const elapsedStr = elapsed < 60 ? `${elapsed}s` : elapsed < 3600 ? `${Math.floor(elapsed / 60)}m` : `${Math.floor(elapsed / 3600)}h`;

    return {
      status,
      name: a.role.name,
      role: a.role.id,
      task: a.current_task ?? (status === "idle" ? "Awaiting assignment" : status === "error" ? "Terminated" : "Active"),
      meta: `${elapsedStr}`,
      flowDelay: status === "running" ? `${i * 0.7}s` : undefined,
    };
  });

  const activeCount = agents.filter(a => a.status === "active").length;

  return (
    <section className="db-fleet-panel" aria-label="Agent Fleet">
      <div className="db-panel-header">
        <h2 className="db-panel-title">Agent Fleet</h2>
        <span className="db-badge db-badge-violet" aria-label={`${activeCount} agents online`}>
          {activeCount > 0 ? `${activeCount} active` : "all idle"}
        </span>
        <button
          className="db-panel-link"
          tabIndex={0}
          aria-label="View agent topology"
          onClick={() => { window.location.hash = "#/office"; }}
        >
          View topology
        </button>
      </div>
      <div className="db-agent-grid" role="list">
        {cards.length > 0 ? (
          cards.map((agent) => (
            <AgentCard key={agent.name + agent.role} {...agent} />
          ))
        ) : (
          <div style={{ gridColumn: "1 / -1", textAlign: "center", color: "var(--text-3)", fontSize: 12, padding: "20px 0" }}>
            No agents registered
          </div>
        )}
      </div>
    </section>
  );
}

/* ================================================================
   WAVEFORM BARS — 38 bars, violet-to-blue gradient center-to-edge
   ================================================================ */
const WAVE_BARS: Array<{ bg: string; min: string; max: string; dur: string; delay: string }> = [
  { bg: "rgba(96,165,250,0.58)",  min: "4px", max: "8px",  dur: "1.80s", delay: "0s" },
  { bg: "rgba(96,165,250,0.60)",  min: "4px", max: "10px", dur: "1.70s", delay: "0.05s" },
  { bg: "rgba(96,165,250,0.62)",  min: "4px", max: "13px", dur: "1.55s", delay: "0.13s" },
  { bg: "rgba(96,165,250,0.63)",  min: "4px", max: "12px", dur: "1.75s", delay: "0.18s" },
  { bg: "rgba(96,165,250,0.65)",  min: "4px", max: "10px", dur: "1.68s", delay: "0.26s" },
  { bg: "rgba(96,165,250,0.67)",  min: "4px", max: "14px", dur: "1.60s", delay: "0.31s" },
  { bg: "rgba(139,92,246,0.70)",  min: "4px", max: "18px", dur: "1.35s", delay: "0.39s" },
  { bg: "rgba(139,92,246,0.72)",  min: "4px", max: "21px", dur: "1.22s", delay: "0.45s" },
  { bg: "rgba(139,92,246,0.74)",  min: "4px", max: "23px", dur: "1.40s", delay: "0.53s" },
  { bg: "rgba(139,92,246,0.76)",  min: "4px", max: "21px", dur: "1.12s", delay: "0.59s" },
  { bg: "rgba(139,92,246,0.78)",  min: "4px", max: "25px", dur: "1.28s", delay: "0.67s" },
  { bg: "rgba(139,92,246,0.80)",  min: "4px", max: "23px", dur: "1.18s", delay: "0.74s" },
  { bg: "rgba(139,92,246,0.86)",  min: "6px", max: "30px", dur: "0.96s", delay: "0.82s" },
  { bg: "rgba(139,92,246,0.88)",  min: "6px", max: "34px", dur: "0.88s", delay: "0.87s" },
  { bg: "rgba(139,92,246,0.90)",  min: "6px", max: "37px", dur: "0.81s", delay: "0.93s" },
  { bg: "rgba(167,139,250,0.95)", min: "6px", max: "40px", dur: "0.75s", delay: "0.99s" },
  { bg: "rgba(167,139,250,0.95)", min: "6px", max: "40px", dur: "0.78s", delay: "1.04s" },
  { bg: "rgba(139,92,246,0.92)",  min: "6px", max: "38px", dur: "0.72s", delay: "1.11s" },
  { bg: "rgba(139,92,246,0.90)",  min: "6px", max: "35px", dur: "0.84s", delay: "1.17s" },
  { bg: "rgba(139,92,246,0.88)",  min: "6px", max: "31px", dur: "0.93s", delay: "1.22s" },
  { bg: "rgba(139,92,246,0.88)",  min: "6px", max: "33px", dur: "0.89s", delay: "1.28s" },
  { bg: "rgba(139,92,246,0.86)",  min: "6px", max: "29px", dur: "0.98s", delay: "1.35s" },
  { bg: "rgba(139,92,246,0.84)",  min: "6px", max: "27px", dur: "1.03s", delay: "1.40s" },
  { bg: "rgba(139,92,246,0.82)",  min: "5px", max: "25px", dur: "1.09s", delay: "1.48s" },
  { bg: "rgba(139,92,246,0.80)",  min: "4px", max: "22px", dur: "1.21s", delay: "1.53s" },
  { bg: "rgba(139,92,246,0.78)",  min: "4px", max: "20px", dur: "1.32s", delay: "1.60s" },
  { bg: "rgba(139,92,246,0.76)",  min: "4px", max: "21px", dur: "1.19s", delay: "1.67s" },
  { bg: "rgba(139,92,246,0.74)",  min: "4px", max: "19px", dur: "1.38s", delay: "1.73s" },
  { bg: "rgba(139,92,246,0.72)",  min: "4px", max: "21px", dur: "1.28s", delay: "1.79s" },
  { bg: "rgba(139,92,246,0.70)",  min: "4px", max: "17px", dur: "1.42s", delay: "1.85s" },
  { bg: "rgba(96,165,250,0.67)",  min: "4px", max: "14px", dur: "1.62s", delay: "1.91s" },
  { bg: "rgba(96,165,250,0.65)",  min: "4px", max: "11px", dur: "1.71s", delay: "1.97s" },
  { bg: "rgba(96,165,250,0.63)",  min: "4px", max: "13px", dur: "1.79s", delay: "2.02s" },
  { bg: "rgba(96,165,250,0.62)",  min: "4px", max: "12px", dur: "1.64s", delay: "2.09s" },
  { bg: "rgba(96,165,250,0.60)",  min: "4px", max: "10px", dur: "1.73s", delay: "2.14s" },
  { bg: "rgba(96,165,250,0.59)",  min: "4px", max: "9px",  dur: "1.82s", delay: "2.20s" },
  { bg: "rgba(96,165,250,0.57)",  min: "4px", max: "8px",  dur: "1.77s", delay: "2.27s" },
  { bg: "rgba(96,165,250,0.55)",  min: "4px", max: "7px",  dur: "1.88s", delay: "2.33s" },
];

/* ================================================================
   VOICE SESSION CARD — wired to voice hook + messages
   ================================================================ */
function VoiceCard({ voice, messages }: { voice: UseVoiceReturn; messages: ChatMessage[] }) {
  const { voiceState, startRecording, stopRecording, cancelTTS } = voice;
  const isActive = voiceState !== "idle";
  const [sessionTime, setSessionTime] = useState(0);
  const sessionStartRef = useRef<number | null>(null);

  // Track session duration
  useEffect(() => {
    if (isActive && !sessionStartRef.current) {
      sessionStartRef.current = Date.now();
    } else if (!isActive) {
      sessionStartRef.current = null;
      setSessionTime(0);
    }
  }, [isActive]);

  useEffect(() => {
    if (!isActive) return;
    const iv = setInterval(() => {
      if (sessionStartRef.current) {
        setSessionTime(Math.floor((Date.now() - sessionStartRef.current) / 1000));
      }
    }, 1000);
    return () => clearInterval(iv);
  }, [isActive]);

  // Get recent voice-related messages for transcript
  const recentMessages = messages.slice(-6).filter(m => m.role === "user" || m.role === "assistant");

  const statusText =
    voiceState === "recording" ? `Recording \u00B7 ${formatSessionTime(sessionTime)}`
    : voiceState === "processing" ? `Processing \u00B7 ${formatSessionTime(sessionTime)}`
    : voiceState === "speaking" ? `Speaking \u00B7 ${formatSessionTime(sessionTime)}`
    : voiceState === "wake_detected" ? "Wake word detected"
    : `Idle \u00B7 tap to speak`;

  const speakingLabel =
    voiceState === "speaking" ? "JARVIS is speaking..."
    : voiceState === "recording" ? "Listening..."
    : voiceState === "processing" ? "Processing speech..."
    : "Tap microphone to start";

  return (
    <section className="db-voice-card" aria-label="Voice session">
      <div className="db-voice-aurora" aria-hidden="true" />
      <div className="db-voice-inner">

        {/* Left: waveform + controls */}
        <div className="db-voice-left">
          <div className="db-voice-title-row">
            <span className="db-voice-title">Voice Session</span>
            <span className="db-voice-status" aria-live="polite">{statusText}</span>
          </div>

          <div className="db-waveform" role="img" aria-label={`Voice waveform \u2014 ${voiceState}`}>
            {WAVE_BARS.map((bar, i) => (
              <div
                key={i}
                className="db-wave-bar"
                style={{
                  background: bar.bg,
                  "--wave-min": bar.min,
                  "--wave-max": isActive ? bar.max : bar.min,
                  "--dur": bar.dur,
                  "--delay": bar.delay,
                  animationPlayState: isActive ? "running" : "paused",
                } as React.CSSProperties}
              />
            ))}
          </div>

          <div className="db-voice-speaking">{speakingLabel}</div>

          <div className="db-voice-controls">
            <button
              className="db-voice-btn"
              title={voiceState === "recording" ? "Stop" : "Start recording"}
              aria-label={voiceState === "recording" ? "Stop recording" : "Start recording"}
              onClick={() => {
                if (voiceState === "recording") stopRecording();
                else if (voiceState === "idle" || voiceState === "wake_detected") startRecording();
              }}
              style={voiceState === "recording" ? { borderColor: "var(--emerald)", color: "var(--emerald)", background: "rgba(52,211,153,0.08)" } : undefined}
            >
              {voiceState === "recording" ? "\u25A0" : "\u25CB"}
            </button>
            <button
              className="db-voice-btn db-voice-btn-end"
              title="Cancel"
              aria-label="Cancel voice session"
              onClick={cancelTTS}
              disabled={!isActive}
              style={!isActive ? { opacity: 0.4 } : undefined}
            >
              &#x2715;
            </button>
            <button className="db-voice-btn" title="Speaker" aria-label="Toggle speaker">&#9679;</button>
          </div>
        </div>

        {/* Right: transcript from real messages */}
        <div className="db-voice-right">
          <div className="db-transcript-label">Recent Transcript</div>

          {recentMessages.length > 0 ? (
            recentMessages.map((msg) => {
              const ts = new Date(msg.timestamp);
              const timeStr = `${ts.getHours()}:${ts.getMinutes().toString().padStart(2, "0")}`;
              const isJarvis = msg.role === "assistant";
              const text = msg.content.length > 200 ? msg.content.slice(0, 200) + "\u2026" : msg.content;
              return (
                <div className="db-transcript-line" key={msg.id}>
                  <span className="db-transcript-ts">{timeStr}</span>
                  <span className={`db-transcript-text ${isJarvis ? "db-transcript-jarvis" : ""}`}>
                    {text}
                  </span>
                </div>
              );
            })
          ) : (
            <div style={{ fontSize: 11, color: "var(--text-3)", fontStyle: "italic" }}>
              No recent messages
            </div>
          )}
        </div>

      </div>
    </section>
  );
}

/* ================================================================
   MEMORY VAULT — wired to /api/vault/entities
   ================================================================ */
function MemoryVault({ entities, entityCount }: { entities: VaultEntity[]; entityCount: number }) {
  // Group entities by type for cluster coloring
  const typeColors: Record<string, string> = {
    person: "rgba(96,165,250,",
    project: "rgba(139,92,246,",
    concept: "rgba(52,211,153,",
    organization: "rgba(96,165,250,",
    tool: "rgba(139,92,246,",
    event: "rgba(52,211,153,",
  };

  // Place up to 12 entities as dots in the constellation
  const dotEntities = entities.slice(0, 12);

  // Deterministic position from entity id hash
  const positions = dotEntities.map((e, i) => {
    const hash = e.id.split("").reduce((acc, c) => acc + c.charCodeAt(0), 0);
    const col = i < 4 ? 0 : i < 8 ? 1 : 2; // 3 clusters
    const baseLeft = col === 0 ? 15 : col === 1 ? 48 : 78;
    const baseTop = 35;
    return {
      top: `${baseTop + ((hash * 7 + i * 13) % 40)}%`,
      left: `${baseLeft + ((hash * 3 + i * 5) % 18)}%`,
      size: 3 + (hash % 4),
      color: (typeColors[e.type] ?? "rgba(139,92,246,") + `${0.2 + (hash % 30) / 100})`,
    };
  });

  // Recent entities for the activity list
  const recent = entities.slice(0, 3);

  return (
    <section className="db-sub-panel db-memory-panel" aria-label="Memory Vault — knowledge graph">
      <div className="db-panel-header">
        <h2 className="db-panel-title">Memory Vault</h2>
        <span className="db-badge db-badge-neutral">
          {entityCount > 999 ? `${(entityCount / 1000).toFixed(1)}k` : entityCount} entities
        </span>
        <button
          className="db-panel-link"
          tabIndex={0}
          aria-label="Explore memory"
          onClick={() => { window.location.hash = "#/memory"; }}
        >
          Explore
        </button>
      </div>

      <div className="db-vault-viz" aria-label="Knowledge graph — entity clusters" role="img">
        <svg aria-hidden="true">
          {/* Cross-cluster flows */}
          <line
            x1="22%" y1="55%" x2="42%" y2="45%"
            stroke="rgba(139,92,246,0.04)" strokeWidth="0.5"
            strokeDasharray="8"
            style={{ animation: "db-flowPulse 8s linear infinite" }}
          />
          <line
            x1="58%" y1="40%" x2="76%" y2="42%"
            stroke="rgba(139,92,246,0.04)" strokeWidth="0.5"
            strokeDasharray="8"
            style={{ animation: "db-flowPulse 11s linear infinite" }}
          />
          {/* Dynamic connections between adjacent dots */}
          {positions.slice(0, -1).map((p, i) => {
            const next = positions[i + 1];
            if (!next) return null;
            return (
              <line
                key={`conn-${i}`}
                x1={p.left} y1={p.top} x2={next.left} y2={next.top}
                stroke="rgba(139,92,246,0.06)" strokeWidth="0.5"
              />
            );
          })}
        </svg>

        {/* Entity dots from real data */}
        {positions.map((pos, i) => {
          const entity = dotEntities[i];
          if (!entity) return null;
          return (
            <div
              key={entity.id}
              className={`db-entity-dot ${i % 3 === 0 ? "db-drift" : ""}`}
              style={{
                width: pos.size,
                height: pos.size,
                background: pos.color,
                top: pos.top,
                left: pos.left,
                ...(i % 3 === 0 ? { "--dur": `${17 + i * 4}s`, "--delay": `${i * 2}s` } as React.CSSProperties : {}),
              }}
            />
          );
        })}

        {/* Labels for first few entities */}
        {dotEntities.slice(0, 6).map((e, i) => {
          const pos = positions[i];
          if (!pos) return null;
          return (
            <div key={`lbl-${e.id}`} className="db-entity-label" style={{ top: pos.top, left: `calc(${pos.left} + 8px)` }}>
              {e.name.length > 14 ? e.name.slice(0, 14) + "\u2026" : e.name}
            </div>
          );
        })}
      </div>

      <div className="db-recent-memories" aria-label="Recent memory activity">
        {recent.length > 0 ? recent.map((e, i) => {
          const colors = ["var(--violet)", "var(--blue)", "var(--emerald)"];
          return (
            <div
              className="db-mem-item"
              key={e.id}
              onClick={() => { window.location.hash = "#/memory"; }}
              style={{ cursor: "pointer" }}
              role="link"
              tabIndex={0}
              onKeyDown={(ev) => { if (ev.key === "Enter") window.location.hash = "#/memory"; }}
            >
              <div className="db-mem-dot" style={{ background: colors[i % 3] }} aria-hidden="true" />
              <span className="db-mem-text">{e.type}: {e.name}</span>
              <span className="db-mem-time">{timeAgo(e.updated_at)}</span>
            </div>
          );
        }) : (
          <div style={{ fontSize: 11, color: "var(--text-3)", fontStyle: "italic" }}>No entities yet</div>
        )}
      </div>
    </section>
  );
}

/* ================================================================
   NEURAL TOPOLOGY — wired to workflow count
   ================================================================ */
function NeuralTopology({ workflowCount }: { workflowCount: number }) {
  return (
    <section className="db-sub-panel db-neural-panel" aria-label="Neural Pathways — active topology">
      <div className="db-panel-header db-neural-header">
        <h2 className="db-panel-title">Neural Pathways</h2>
        <div className="db-neural-pulse" aria-hidden="true" />
        <span
          className="db-badge"
          style={{ background: "transparent", color: "var(--text-2)", paddingLeft: 0, border: "none" }}
        >
          {workflowCount} active
        </span>
        <button
          className="db-panel-link"
          tabIndex={0}
          aria-label="View workflows"
          onClick={() => { window.location.hash = "#/workflows"; }}
        >
          View workflows
        </button>
      </div>

      <div className="db-neural-svg-wrap">
        <svg
          width="100%"
          height="148"
          viewBox="0 0 320 148"
          aria-label="Neural network topology — 7 nodes, active path highlighted"
          role="img"
        >
          <defs>
            <filter id="db-nodeGlow" x="-60%" y="-60%" width="220%" height="220%">
              <feGaussianBlur in="SourceGraphic" stdDeviation="3.5" result="blur" />
              <feFlood floodColor="rgba(139,92,246,0.5)" result="color" />
              <feComposite in="color" in2="blur" operator="in" result="glow" />
              <feMerge>
                <feMergeNode in="glow" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
            <filter id="db-coreGlow" x="-70%" y="-70%" width="240%" height="240%">
              <feGaussianBlur in="SourceGraphic" stdDeviation="6" result="blur" />
              <feFlood floodColor="rgba(139,92,246,0.65)" result="color" />
              <feComposite in="color" in2="blur" operator="in" result="glow" />
              <feMerge>
                <feMergeNode in="glow" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          {/* Idle paths — Input → all hidden layer */}
          <line className="db-path-idle" x1="30"  y1="74"  x2="120" y2="30" />
          <line className="db-path-idle" x1="30"  y1="74"  x2="120" y2="74" />
          <line className="db-path-idle" x1="30"  y1="74"  x2="120" y2="118" />

          {/* Language → Reasoning: ACTIVE */}
          <line className="db-path-active" style={{ "--fp": "4s" } as React.CSSProperties} x1="120" y1="30"  x2="210" y2="46" />
          {/* Vision → Reasoning: idle */}
          <line className="db-path-idle" x1="120" y1="74"  x2="210" y2="46" />
          {/* Memory → Reasoning: ACTIVE (faint) */}
          <line className="db-path-active" style={{ "--fp": "6s" } as React.CSSProperties} x1="120" y1="118" x2="210" y2="46" />
          {/* Hidden → Action: idle */}
          <line className="db-path-idle" x1="120" y1="30"  x2="210" y2="100" />
          <line className="db-path-idle" x1="120" y1="74"  x2="210" y2="100" />
          <line className="db-path-idle" x1="120" y1="118" x2="210" y2="100" />
          {/* Reasoning → Core: ACTIVE (main) */}
          <line className="db-path-active" style={{ "--fp": "3s" } as React.CSSProperties} x1="210" y1="46"  x2="290" y2="74" />
          {/* Action → Core: idle */}
          <line className="db-path-idle" x1="210" y1="100" x2="290" y2="74" />

          {/* Input node — neutral */}
          <circle cx="30" cy="74" r="14"
            fill="var(--surface-2)"
            stroke="rgba(255,255,255,0.06)"
            strokeWidth="1.5"
          />
          <text x="30" y="97" textAnchor="middle" className="db-node-label" fill="rgba(255,255,255,0.28)">Input</text>

          {/* Language node — ACTIVE */}
          <circle cx="120" cy="30" r="14"
            fill="var(--surface-2)"
            stroke="rgba(139,92,246,0.50)"
            strokeWidth="1.5"
            filter="url(#db-nodeGlow)"
          />
          <text x="120" y="53" textAnchor="middle" className="db-node-label" fill="rgba(255,255,255,0.55)">Language</text>

          {/* Vision node — idle */}
          <circle cx="120" cy="74" r="14"
            fill="var(--surface-2)"
            stroke="rgba(255,255,255,0.05)"
            strokeWidth="1.5"
          />
          <text x="120" y="97" textAnchor="middle" className="db-node-label" fill="rgba(255,255,255,0.20)">Vision</text>

          {/* Memory node — lightly active */}
          <circle cx="120" cy="118" r="14"
            fill="var(--surface-2)"
            stroke="rgba(139,92,246,0.28)"
            strokeWidth="1.5"
            filter="url(#db-nodeGlow)"
          />
          <text x="120" y="141" textAnchor="middle" className="db-node-label" fill="rgba(255,255,255,0.40)">Memory</text>

          {/* Reasoning node — MOST ACTIVE */}
          <circle cx="210" cy="46" r="15"
            fill="var(--surface-2)"
            stroke="rgba(139,92,246,0.65)"
            strokeWidth="2"
            filter="url(#db-nodeGlow)"
          />
          <text x="210" y="70" textAnchor="middle" className="db-node-label" fill="rgba(255,255,255,0.60)">Reasoning</text>

          {/* Action node — idle */}
          <circle cx="210" cy="100" r="14"
            fill="var(--surface-2)"
            stroke="rgba(255,255,255,0.05)"
            strokeWidth="1.5"
          />
          <text x="210" y="123" textAnchor="middle" className="db-node-label" fill="rgba(255,255,255,0.20)">Action</text>

          {/* Core node — main */}
          <circle cx="290" cy="74" r="18"
            fill="var(--surface-2)"
            stroke="rgba(139,92,246,0.70)"
            strokeWidth="2"
            filter="url(#db-coreGlow)"
          />
          <text x="290" y="101" textAnchor="middle" className="db-node-label" fill="rgba(255,255,255,0.55)">Core</text>
        </svg>
      </div>

      <div className="db-neural-pathway-label">
        Active: Input → Language → Reasoning → Core
      </div>
    </section>
  );
}

/* ================================================================
   GOALS PANEL — wired to /api/goals
   ================================================================ */
interface GoalItemProps {
  name: string;
  pct: number;
  priority: "p1" | "p2" | "p3";
  delay: string;
}

function GoalItem({ name, pct, priority, delay }: GoalItemProps) {
  return (
    <div
      className="db-goal-item"
      onClick={() => { window.location.hash = "#/goals"; }}
      style={{ cursor: "pointer" }}
      role="link"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter") window.location.hash = "#/goals"; }}
    >
      <div className="db-goal-name">{name}</div>
      <div
        className="db-goal-track"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${pct}% complete`}
      >
        <div
          className="db-goal-fill"
          style={{ "--bar-w": `${pct}%`, "--delay": delay } as React.CSSProperties}
        />
      </div>
      <div className="db-goal-foot">
        <span className="db-goal-pct">{pct}%</span>
        <span className={`db-priority db-${priority}`}>{priority.toUpperCase()}</span>
      </div>
    </div>
  );
}

function GoalsPanel({ goals }: { goals: GoalData[] }) {
  const items: GoalItemProps[] = goals.slice(0, 4).map((g, i) => {
    const pct = Math.round(g.score * 100);
    const priority: "p1" | "p2" | "p3" =
      g.health === "critical" || g.health === "behind" ? "p1"
      : g.health === "at_risk" ? "p2"
      : "p3";
    return {
      name: g.title,
      pct,
      priority,
      delay: `${i * 100}ms`,
    };
  });

  const activeCount = goals.filter(g => g.status === "active").length;

  return (
    <section className="db-goals-panel" aria-label="Active goals">
      <div className="db-panel-header">
        <h2 className="db-panel-title">Goals</h2>
        <span style={{ fontSize: 12, color: "var(--text-2)" }} aria-label={`${activeCount} active goals`}>
          {activeCount} active
        </span>
        <button
          className="db-panel-link"
          tabIndex={0}
          aria-label="View all goals"
          onClick={() => { window.location.hash = "#/goals"; }}
        >
          View all
        </button>
      </div>
      <div className="db-goals-grid">
        {items.length > 0 ? (
          items.map((goal) => (
            <GoalItem key={goal.name} {...goal} />
          ))
        ) : (
          <div style={{ fontSize: 12, color: "var(--text-3)", fontStyle: "italic", padding: "12px 0" }}>
            No active goals
          </div>
        )}
      </div>
    </section>
  );
}

/* ================================================================
   DASHBOARD PAGE — root export, data fetching
   ================================================================ */
export default function DashboardPage({ messages, isConnected, voice, agentActivity, goalEvents, workflowEvents }: DashboardProps) {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [health, setHealth] = useState<HealthData | null>(null);
  const [entities, setEntities] = useState<VaultEntity[]>([]);
  const [entityCount, setEntityCount] = useState(0);
  const [goals, setGoals] = useState<GoalData[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowData[]>([]);

  // Fetch agents (poll every 5s)
  const fetchAgents = useCallback(async () => {
    try {
      const data = await api<AgentInfo[]>("/api/agents");
      setAgents(data);
    } catch { /* keep previous */ }
  }, []);

  // Fetch health (poll every 10s)
  const fetchHealth = useCallback(async () => {
    try {
      const data = await api<HealthData>("/api/health");
      setHealth(data);
    } catch { /* keep previous */ }
  }, []);

  // Fetch entities (on mount + every 30s)
  const fetchEntities = useCallback(async () => {
    try {
      const data = await api<VaultEntity[]>("/api/vault/entities");
      setEntityCount(data.length);
      setEntities(data.slice(0, 20)); // keep top 20 most recent
    } catch { /* keep previous */ }
  }, []);

  // Fetch goals (on mount + on goal events)
  const fetchGoals = useCallback(async () => {
    try {
      const data = await api<GoalData[]>("/api/goals?status=active&limit=8");
      setGoals(data);
    } catch { /* keep previous */ }
  }, []);

  // Fetch workflows (on mount + on workflow events)
  const fetchWorkflows = useCallback(async () => {
    try {
      const data = await api<WorkflowData[]>("/api/workflows");
      setWorkflows(data);
    } catch { /* keep previous */ }
  }, []);

  // Initial fetch
  useEffect(() => {
    fetchAgents();
    fetchHealth();
    fetchEntities();
    fetchGoals();
    fetchWorkflows();
  }, [fetchAgents, fetchHealth, fetchEntities, fetchGoals, fetchWorkflows]);

  // Polling intervals
  useEffect(() => {
    const agentIv = setInterval(fetchAgents, 5000);
    const healthIv = setInterval(fetchHealth, 10000);
    const entityIv = setInterval(fetchEntities, 30000);
    return () => {
      clearInterval(agentIv);
      clearInterval(healthIv);
      clearInterval(entityIv);
    };
  }, [fetchAgents, fetchHealth, fetchEntities]);

  // Re-fetch on WS events
  useEffect(() => {
    if (goalEvents.length > 0) fetchGoals();
  }, [goalEvents.length, fetchGoals]);

  useEffect(() => {
    if (workflowEvents.length > 0) fetchWorkflows();
  }, [workflowEvents.length, fetchWorkflows]);

  return (
    <div className="dashboard">
      <Atmosphere />
      <div className="db-scroll">
        <div className="db-inner">
          <HeroRow agents={agents} health={health} entityCount={entityCount} workflowCount={workflows.length} />
          <AgentFleet agents={agents} />
          <VoiceCard voice={voice} messages={messages} />
          <div className="db-two-col">
            <MemoryVault entities={entities} entityCount={entityCount} />
            <NeuralTopology workflowCount={workflows.length} />
          </div>
          <GoalsPanel goals={goals} />
        </div>
      </div>
    </div>
  );
}

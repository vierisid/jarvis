import React, { useState } from "react";
import type { AgentActivityEvent } from "../../hooks/useWebSocket";
import type { AgentWithLive } from "./CommandCenterView";

type OrbitalPosition = {
  left: string;
  top: string;
  ring: "center" | "inner" | "outer";
};

const ORBITAL_POSITIONS: Record<string, OrbitalPosition> = {
  "personal-assistant":    { left: "50%", top: "48%", ring: "center" },
  "software-engineer":     { left: "30%", top: "25%", ring: "inner" },
  "research-analyst":      { left: "70%", top: "25%", ring: "inner" },
  "content-writer":        { left: "22%", top: "55%", ring: "inner" },
  "data-analyst":          { left: "78%", top: "55%", ring: "inner" },
  "system-administrator":  { left: "50%", top: "72%", ring: "inner" },
  "legal-advisor":         { left: "12%", top: "38%", ring: "outer" },
  "financial-analyst":     { left: "15%", top: "18%", ring: "outer" },
  "hr-specialist":         { left: "50%", top: "8%",  ring: "outer" },
  "project-coordinator":   { left: "85%", top: "18%", ring: "outer" },
  "marketing-strategist":  { left: "88%", top: "38%", ring: "outer" },
  "customer-support":      { left: "50%", top: "85%", ring: "outer" },
};

// The PA center in SVG coordinates (matching left:50%, top:48%)
const PA_SVG = { x: 50, y: 48 };

type Props = {
  agents: AgentWithLive[];
  agentActivity: AgentActivityEvent[];
};

function pctToNum(pct: string): number {
  return parseFloat(pct.replace("%", ""));
}

function formatTickerEvent(event: AgentActivityEvent): React.ReactNode {
  if (event.eventType === "tool_call") {
    const name = (event.data as { name?: string })?.name ?? "unknown";
    return (
      <>
        <span className="ag-ticker-cyan">{event.agentName}</span> called {name}
      </>
    );
  }
  if (event.eventType === "done") {
    return (
      <>
        <span className="ag-ticker-emerald">{event.agentName}</span> completed task
      </>
    );
  }
  const text = (event.data as { text?: string })?.text ?? "";
  return (
    <>
      <span className="ag-ticker-violet">{event.agentName}</span>{" "}
      {text.length > 50 ? text.slice(0, 50) + "…" : text}
    </>
  );
}

function getAvatarBgForCard(agent: AgentWithLive): string {
  // Convert "ag-avatar-violet" → "rgba(139,92,246,0.14)"
  const colorMap: Record<string, string> = {
    "ag-avatar-violet":  "rgba(139,92,246,0.14)",
    "ag-avatar-blue":    "rgba(96,165,250,0.14)",
    "ag-avatar-emerald": "rgba(52,211,153,0.14)",
    "ag-avatar-cyan":    "rgba(34,211,238,0.12)",
    "ag-avatar-amber":   "rgba(251,191,36,0.12)",
    "ag-avatar-rose":    "rgba(251,113,133,0.12)",
  };
  return colorMap[agent.avatarBg] ?? "rgba(139,92,246,0.14)";
}

function getBubbleBg(agent: AgentWithLive): string {
  const colorMap: Record<string, string> = {
    "ag-avatar-violet":  "rgba(139,92,246,0.16)",
    "ag-avatar-blue":    "rgba(96,165,250,0.16)",
    "ag-avatar-emerald": "rgba(52,211,153,0.16)",
    "ag-avatar-cyan":    "rgba(34,211,238,0.12)",
    "ag-avatar-amber":   "rgba(251,191,36,0.12)",
    "ag-avatar-rose":    "rgba(251,113,133,0.12)",
  };
  return colorMap[agent.avatarBg] ?? "rgba(139,92,246,0.16)";
}

function getIdleBubbleBg(agent: AgentWithLive, ring: "inner" | "outer"): string {
  const opacity = ring === "inner" ? "0.10" : "0.08";
  const colorMap: Record<string, string> = {
    "ag-avatar-violet":  `rgba(139,92,246,${opacity})`,
    "ag-avatar-blue":    `rgba(96,165,250,${opacity})`,
    "ag-avatar-emerald": `rgba(52,211,153,${opacity})`,
    "ag-avatar-cyan":    `rgba(34,211,238,${opacity})`,
    "ag-avatar-amber":   `rgba(251,191,36,${opacity})`,
    "ag-avatar-rose":    `rgba(251,113,133,${opacity})`,
  };
  return colorMap[agent.avatarBg] ?? `rgba(139,92,246,${opacity})`;
}

export default function OrbitalView({ agents, agentActivity }: Props) {
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);

  const activeAgents = agents.filter(
    (a) => !a.isPrimary && a.live?.busy
  );
  const activeCount = activeAgents.length + 1; // +1 for PA (always active)

  // Agents for nodes (excluding PA which is the center orb)
  const nodeAgents = agents.filter((a) => !a.isPrimary);

  const selectedAgent = selectedRoleId
    ? agents.find((a) => a.roleId === selectedRoleId) ?? null
    : null;

  function handleNodeClick(roleId: string) {
    setSelectedRoleId((prev) => (prev === roleId ? null : roleId));
  }

  // Ticker events (duplicate for seamless loop)
  const tickerEvents = agentActivity.slice(0, 10);
  const loopedTicker = [...tickerEvents, ...tickerEvents];

  return (
    <div className="ag-view ag-orbital-view visible" style={{ flex: 1, position: "relative" }}>
      {/* Aurora background */}
      <div className="ag-aurora" />

      {/* Orbital canvas */}
      <div className="ag-orbital-canvas">

        {/* SVG connection lines */}
        <svg
          className="ag-lines-svg"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <defs>
            <filter id="ag-lineGlow" x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur stdDeviation="0.6" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
            <filter id="ag-dotGlow" x="-100%" y="-100%" width="300%" height="300%">
              <feGaussianBlur stdDeviation="0.8" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>

            {/* Gradients for each active agent line */}
            {activeAgents.map((agent, i) => {
              const pos = ORBITAL_POSITIONS[agent.roleId];
              if (!pos) return null;
              const tx = pctToNum(pos.left);
              const ty = pctToNum(pos.top);
              return (
                <linearGradient
                  key={agent.roleId}
                  id={`ag-grad-${i}`}
                  x1={`${PA_SVG.x}%`}
                  y1={`${PA_SVG.y}%`}
                  x2={`${tx}%`}
                  y2={`${ty}%`}
                  gradientUnits="userSpaceOnUse"
                >
                  <stop offset="0%" stopColor="#8B5CF6" stopOpacity="0.7" />
                  <stop offset="100%" stopColor="#22D3EE" stopOpacity="0.7" />
                </linearGradient>
              );
            })}
          </defs>

          {/* Orbital ring traces */}
          <ellipse
            cx="50" cy="48" rx="22" ry="25"
            fill="none"
            stroke="rgba(255,255,255,0.04)"
            strokeWidth="0.5"
            strokeDasharray="2 4"
          />
          <ellipse
            cx="50" cy="48" rx="40" ry="40"
            fill="none"
            stroke="rgba(255,255,255,0.025)"
            strokeWidth="0.4"
            strokeDasharray="2 6"
          />

          {/* Active connection lines + particles */}
          {activeAgents.map((agent, i) => {
            const pos = ORBITAL_POSITIONS[agent.roleId];
            if (!pos) return null;
            const tx = pctToNum(pos.left);
            const ty = pctToNum(pos.top);
            const dur1 = 2.4 + i * 0.4;
            const dur2 = dur1;
            const dashDur = 1.2 + i * 0.3;
            const pathId = `ag-path-${i}`;

            return (
              <g key={agent.roleId}>
                {/* Base glow line */}
                <line
                  x1={PA_SVG.x} y1={PA_SVG.y}
                  x2={tx} y2={ty}
                  stroke={`url(#ag-grad-${i})`}
                  strokeWidth="0.35"
                  filter="url(#ag-lineGlow)"
                  opacity="0.5"
                />
                {/* Dashed animated line */}
                <line
                  x1={PA_SVG.x} y1={PA_SVG.y}
                  x2={tx} y2={ty}
                  stroke="rgba(139,92,246,0.4)"
                  strokeWidth="1.5"
                  strokeDasharray="6 4"
                  vectorEffect="non-scaling-stroke"
                >
                  <animate
                    attributeName="stroke-dashoffset"
                    from="0"
                    to="-20"
                    dur={`${dashDur}s`}
                    repeatCount="indefinite"
                  />
                </line>

                {/* Hidden path for animateMotion */}
                <path
                  id={pathId}
                  d={`M ${PA_SVG.x} ${PA_SVG.y} L ${tx} ${ty}`}
                  fill="none"
                  stroke="none"
                />

                {/* Particle 1 */}
                <circle r="0.6" fill="#22D3EE" opacity="0.95" filter="url(#ag-dotGlow)">
                  <animateMotion dur={`${dur1}s`} repeatCount="indefinite" begin="0s">
                    <mpath href={`#${pathId}`} />
                  </animateMotion>
                </circle>

                {/* Particle 2 */}
                <circle r="0.45" fill="#8B5CF6" opacity="0.75" filter="url(#ag-dotGlow)">
                  <animateMotion dur={`${dur2}s`} repeatCount="indefinite" begin={`${dur1 / 2}s`}>
                    <mpath href={`#${pathId}`} />
                  </animateMotion>
                </circle>
              </g>
            );
          })}
        </svg>

        {/* Center Orb — Personal Assistant */}
        <div className="ag-center-orb" style={{ left: "50%", top: "48%" }}>
          <div className="ag-orb-cluster">
            <div
              className="ag-orb-ring-outer"
              style={{
                width: "116px",
                height: "116px",
                top: "50%",
                left: "50%",
              }}
            />
            <div
              className="ag-orb-ring-inner"
              style={{
                width: "96px",
                height: "96px",
                top: "50%",
                left: "50%",
              }}
            />
            <div className="ag-orb-core">🤖</div>
          </div>
          <div className="ag-orb-label">Personal Assistant</div>
          <div className="ag-orb-badge">PRIMARY · AUTH 5</div>
        </div>

        {/* Orbital Nodes */}
        {nodeAgents.map((agent) => {
          const pos = ORBITAL_POSITIONS[agent.roleId];
          if (!pos) return null;

          const isActive = Boolean(agent.live?.busy);
          const ring = pos.ring as "inner" | "outer";

          let bubbleClass = "ag-node-bubble";
          let bubbleBg = "";
          let labelClass = "ag-node-label";
          let dotClass = "ag-bubble-dot";

          if (isActive) {
            bubbleClass += " size-lg active-node";
            bubbleBg = getBubbleBg(agent);
            dotClass += " active";
          } else if (ring === "inner") {
            bubbleClass += " size-md idle-inner";
            bubbleBg = getIdleBubbleBg(agent, "inner");
            labelClass += " dimmed";
            dotClass += " idle";
          } else {
            bubbleClass += " size-sm idle-outer";
            bubbleBg = getIdleBubbleBg(agent, "outer");
            labelClass += " dimmed";
            dotClass += " idle";
          }

          return (
            <div
              key={agent.roleId}
              className="ag-orbital-node"
              style={{ left: pos.left, top: pos.top }}
              onClick={() => handleNodeClick(agent.roleId)}
            >
              <div className={bubbleClass} style={{ background: bubbleBg }}>
                {agent.emoji}
                <span className={dotClass} />
              </div>
              <div className={labelClass}>
                {ring === "outer"
                  ? agent.name.split(" ")[0]
                  : agent.name}
              </div>
              {isActive && agent.live?.current_task && (
                <div className="ag-node-task-mini">
                  {agent.live.current_task.length > 20
                    ? agent.live.current_task.slice(0, 20) + "…"
                    : agent.live.current_task}
                </div>
              )}
            </div>
          );
        })}

        {/* Floating Detail Card */}
        {selectedAgent && (() => {
          const pos = ORBITAL_POSITIONS[selectedAgent.roleId];
          if (!pos) return null;

          const leftPct = pctToNum(pos.left);
          const topPct = pctToNum(pos.top);
          const isActive = selectedAgent.live?.status === "active";

          // Place the card near the node but avoid overflow
          const cardLeft = leftPct > 60 ? `${leftPct - 22}%` : `${leftPct + 4}%`;
          const cardTop = topPct > 60 ? `${topPct - 38}%` : `${topPct + 4}%`;

          return (
            <div
              className="ag-detail-card"
              style={{ left: cardLeft, top: cardTop }}
            >
              <div className="ag-dc-header">
                <div
                  className="ag-dc-emoji"
                  style={{ background: getAvatarBgForCard(selectedAgent) }}
                >
                  {selectedAgent.emoji}
                </div>
                <div>
                  <div className="ag-dc-name">{selectedAgent.name}</div>
                  <div className="ag-dc-status">
                    <span
                      className={`ag-dc-dot${isActive ? " active" : ""}`}
                    />
                    <span
                      style={{
                        color: isActive ? "var(--cyan)" : "var(--text-3)",
                        fontSize: "10px",
                        fontWeight: 600,
                      }}
                    >
                      {isActive ? "Active" : "Idle"}
                    </span>
                    <span style={{ color: "var(--text-3)", fontSize: "10px" }}>
                      {" "}· Auth {selectedAgent.authority}
                    </span>
                  </div>
                </div>
              </div>
              <div className="ag-dc-section-label">Current Task</div>
              <div className="ag-dc-task">
                {selectedAgent.live?.current_task ?? "No active task"}
              </div>
              <div className="ag-dc-section-label">Authority</div>
              <div className="ag-dc-auth">
                {Array.from({ length: 10 }, (_, i) => (
                  <div
                    key={i}
                    className={`ag-dc-pip ${i < selectedAgent.authority ? "on" : "off"}`}
                  />
                ))}
                <span className="ag-dc-auth-val">
                  {selectedAgent.authority} / 10
                </span>
              </div>
              <div className="ag-dc-section-label">Tools</div>
              <div className="ag-dc-tools">
                {/* Show generic tool count badges since we don't have tool names */}
                {Array.from({ length: Math.min(selectedAgent.tools, 6) }, (_, i) => (
                  <span key={i} className="ag-dc-tool">
                    tool_{i + 1}
                  </span>
                ))}
                {selectedAgent.tools > 6 && (
                  <span className="ag-dc-tool">
                    +{selectedAgent.tools - 6} more
                  </span>
                )}
              </div>
            </div>
          );
        })()}
      </div>

      {/* Orbital Bottom Bar */}
      <div className="ag-orbital-bottom">
        <div className="ag-bottom-stats">
          <div className="ag-bs-item">
            <div className="ag-bs-val cyan">{activeCount}</div>
            <div className="ag-bs-key">Active</div>
          </div>
          <div className="ag-bs-item">
            <div className="ag-bs-val emerald">—</div>
            <div className="ag-bs-key">Tasks / 24h</div>
          </div>
          <div className="ag-bs-item">
            <div className="ag-bs-val violet">—</div>
            <div className="ag-bs-key">Avg Response</div>
          </div>
          <div className="ag-bs-item">
            <div className="ag-bs-val amber">{activeAgents.length > 0 ? 2 : 1}</div>
            <div className="ag-bs-key">Depth</div>
          </div>
        </div>
        <div className="ag-bottom-divider" />
        <div className="ag-ticker-wrap">
          <div className="ag-ticker-label">Live Feed</div>
          {loopedTicker.length > 0 ? (
            <div className="ag-ticker-scroll">
              {loopedTicker.map((event, idx) => (
                <React.Fragment key={`${event.id}-${idx}`}>
                  {formatTickerEvent(event)}
                  <span className="ag-ticker-sep">·</span>
                </React.Fragment>
              ))}
            </div>
          ) : (
            <div
              style={{
                fontSize: "11px",
                color: "var(--text-3)",
                fontStyle: "italic",
              }}
            >
              No recent activity
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

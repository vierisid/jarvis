import React from "react";
import type { AgentActivityEvent } from "../../hooks/useWebSocket";

export type LiveAgentInfo = {
  id: string;
  role: { id: string; name: string };
  status: "active" | "idle" | "terminated";
  current_task: string | null;
  created_at: number;
};

export type AgentWithLive = {
  roleId: string;
  name: string;
  emoji: string;
  authority: number;
  tools: number;
  avatarBg: string;
  isPrimary?: boolean;
  live: LiveAgentInfo | null;
};

type Props = {
  agents: AgentWithLive[];
  agentActivity: AgentActivityEvent[];
};

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatRelativeTime(ts: number): string {
  const diffMs = Date.now() - ts;
  const diffMin = Math.floor(diffMs / 60000);
  const diffHrs = Math.floor(diffMin / 60);
  const diffDays = Math.floor(diffHrs / 24);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHrs < 24) return formatTime(ts);
  if (diffDays === 1) return "yesterday";
  return `${diffDays}d ago`;
}

function formatActivityText(event: AgentActivityEvent): string {
  if (event.eventType === "tool_call") {
    const name = (event.data as { name?: string })?.name ?? "unknown";
    return `called ${name}`;
  }
  if (event.eventType === "done") {
    return "completed task";
  }
  const text = (event.data as { text?: string })?.text ?? "";
  return text.length > 60 ? text.slice(0, 60) + "…" : text;
}

function getEventDotColor(event: AgentActivityEvent): string {
  if (event.eventType === "done") return "var(--emerald)";
  if (event.eventType === "tool_call") return "var(--cyan)";
  return "var(--violet)";
}

function AuthorityBar({
  authority,
  isPrimary,
  isActive,
}: {
  authority: number;
  isPrimary?: boolean;
  isActive?: boolean;
}) {
  const pipClass = isPrimary ? "filled" : isActive ? "filled cyan" : "filled";
  return (
    <div className="ag-authority-bar">
      {Array.from({ length: 10 }, (_, i) => (
        <div
          key={i}
          className={`ag-authority-pip ${i < authority ? pipClass : "empty"}`}
        />
      ))}
      <span className="ag-authority-label">Auth {authority}</span>
    </div>
  );
}

function AgentCard({ agent }: { agent: AgentWithLive }) {
  const { live, isPrimary } = agent;
  const isActive = live?.status === "active";

  const cardClass = [
    "ag-card",
    isPrimary ? "primary-card" : isActive ? "active-card" : "",
  ]
    .filter(Boolean)
    .join(" ");

  let statusLabel: string;
  let statusClass: string;
  if (isPrimary) {
    statusLabel = "Primary";
    statusClass = "ag-status-badge primary-status";
  } else if (isActive) {
    statusLabel = "Active";
    statusClass = "ag-status-badge active";
  } else {
    statusLabel = "Idle";
    statusClass = "ag-status-badge idle";
  }

  const currentTask = live?.current_task ?? null;
  const sinceTs = live?.created_at ?? null;

  let timeLabel = "";
  if (isPrimary || isActive) {
    timeLabel = sinceTs ? `since ${formatTime(sinceTs)}` : "";
  } else {
    timeLabel = sinceTs ? `last: ${formatRelativeTime(sinceTs)}` : "";
  }

  return (
    <div className={cardClass}>
      <div className="ag-card-body">
        <div className={`ag-avatar ${agent.avatarBg}`}>{agent.emoji}</div>
        <div className="ag-card-info">
          <div className="ag-card-name">{agent.name}</div>
          <div className={`ag-card-task${currentTask ? "" : " no-task"}`}>
            {currentTask ?? "Waiting for tasks…"}
          </div>
        </div>
        <div className={statusClass}>
          <span className="ag-status-dot" />
          {statusLabel}
        </div>
      </div>
      <div className="ag-card-footer">
        <AuthorityBar
          authority={agent.authority}
          isPrimary={isPrimary}
          isActive={isActive && !isPrimary}
        />
        <div className="ag-footer-spacer" />
        <span className="ag-tools-badge">{agent.tools} tools</span>
        {timeLabel && <span className="ag-since-label">{timeLabel}</span>}
      </div>
    </div>
  );
}

export default function CommandCenterView({ agents, agentActivity }: Props) {
  const activeAgents = agents.filter(
    (a) => a.isPrimary || a.live?.status === "active"
  );
  const idleAgents = agents.filter(
    (a) => !a.isPrimary && a.live?.status !== "active"
  );

  // Duplicate events for seamless scrolling loop
  const feedEvents = agentActivity.slice(0, 20);
  const loopedEvents = [...feedEvents, ...feedEvents];

  return (
    <>
      <div className="ag-view visible" style={{ flex: 1 }}>
        <main className="ag-grid-area">
          {activeAgents.length > 0 && (
            <>
              <div className="ag-section-label">Active</div>
              <div className="ag-grid">
                {activeAgents.map((agent) => (
                  <AgentCard key={agent.roleId} agent={agent} />
                ))}
              </div>
            </>
          )}

          {idleAgents.length > 0 && (
            <>
              <div className="ag-section-label">Idle</div>
              <div className="ag-grid">
                {idleAgents.map((agent) => (
                  <AgentCard key={agent.roleId} agent={agent} />
                ))}
              </div>
            </>
          )}
        </main>

        <div className="ag-activity-bar">
          <div className="ag-activity-label">Live</div>
          <div className="ag-activity-track">
            {loopedEvents.length > 0 ? (
              <div className="ag-activity-scroll">
                {loopedEvents.map((event, idx) => (
                  <div key={`${event.id}-${idx}`} className="ag-activity-event">
                    <span
                      className="ag-event-dot"
                      style={{ background: getEventDotColor(event) }}
                    />
                    <span className="ag-event-time">{formatTime(event.timestamp)}</span>
                    <span>
                      <span className="ag-event-agent">{event.agentName}</span>{" "}
                      {formatActivityText(event)}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div
                style={{
                  padding: "0 16px",
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
    </>
  );
}

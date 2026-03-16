import React, { useState, useEffect, useCallback } from "react";
import { api } from "../hooks/useApi";
import type { AgentActivityEvent } from "../hooks/useWebSocket";
import CommandCenterView from "../components/office/CommandCenterView";
import OrbitalView from "../components/office/OrbitalView";
import type { AgentWithLive, LiveAgentInfo } from "../components/office/CommandCenterView";
import "../styles/agents.css";

/* ── Static agent roster ── */
const AGENT_ROSTER = [
  { roleId: "personal-assistant",   name: "Personal Assistant",   emoji: "\u{1F916}",               authority: 5, tools: 14, avatarBg: "ag-avatar-violet", isPrimary: true },
  { roleId: "software-engineer",    name: "Software Engineer",    emoji: "\u{1F468}\u200D\u{1F4BB}", authority: 4, tools: 8,  avatarBg: "ag-avatar-blue" },
  { roleId: "research-analyst",     name: "Research Analyst",     emoji: "\u{1F52C}",                authority: 3, tools: 6,  avatarBg: "ag-avatar-emerald" },
  { roleId: "content-writer",       name: "Content Writer",       emoji: "\u270D\uFE0F",             authority: 3, tools: 5,  avatarBg: "ag-avatar-violet" },
  { roleId: "data-analyst",         name: "Data Analyst",         emoji: "\u{1F4CA}",                authority: 3, tools: 7,  avatarBg: "ag-avatar-cyan" },
  { roleId: "system-administrator", name: "System Administrator", emoji: "\u{1F5A5}\uFE0F",          authority: 4, tools: 10, avatarBg: "ag-avatar-amber" },
  { roleId: "legal-advisor",        name: "Legal Advisor",        emoji: "\u2696\uFE0F",             authority: 3, tools: 4,  avatarBg: "ag-avatar-rose" },
  { roleId: "financial-analyst",    name: "Financial Analyst",    emoji: "\u{1F4B0}",                authority: 3, tools: 5,  avatarBg: "ag-avatar-emerald" },
  { roleId: "hr-specialist",        name: "HR Specialist",        emoji: "\u{1F465}",                authority: 2, tools: 4,  avatarBg: "ag-avatar-blue" },
  { roleId: "project-coordinator",  name: "Project Coordinator",  emoji: "\u{1F4CB}",                authority: 3, tools: 6,  avatarBg: "ag-avatar-amber" },
  { roleId: "marketing-strategist", name: "Marketing Strategist", emoji: "\u{1F4E3}",                authority: 3, tools: 5,  avatarBg: "ag-avatar-rose" },
  { roleId: "customer-support",     name: "Customer Support",     emoji: "\u{1F3A7}",                authority: 2, tools: 4,  avatarBg: "ag-avatar-cyan" },
];

type Props = {
  agentActivity: AgentActivityEvent[];
};

type TabId = "command" | "orbital";

export default function OfficePage({ agentActivity }: Props) {
  const [liveAgents, setLiveAgents] = useState<LiveAgentInfo[]>([]);
  const [activeTab, setActiveTab] = useState<TabId>("command");
  const [search, setSearch] = useState("");

  const fetchAgents = useCallback(async () => {
    try {
      const data = await api<LiveAgentInfo[]>("/api/agents");
      setLiveAgents(data);
    } catch {
      /* keep previous */
    }
  }, []);

  useEffect(() => {
    fetchAgents();
    const interval = setInterval(fetchAgents, 5000);
    return () => clearInterval(interval);
  }, [fetchAgents]);

  function getLive(roleId: string): LiveAgentInfo | null {
    return (
      liveAgents.find(
        (a) =>
          a.role?.id === roleId ||
          a.role?.name?.toLowerCase().replace(/\s+/g, "-") === roleId
      ) ?? null
    );
  }

  // Build combined agent list
  const allAgents: AgentWithLive[] = AGENT_ROSTER.map((r) => ({
    ...r,
    live: getLive(r.roleId),
  }));

  // Apply search filter
  const filteredAgents = search.trim()
    ? allAgents.filter((a) =>
        a.name.toLowerCase().includes(search.toLowerCase())
      )
    : allAgents;

  // Stats
  const activeCount = allAgents.filter(
    (a) => a.isPrimary || a.live?.status === "active"
  ).length;
  const totalCount = AGENT_ROSTER.length;

  return (
    <div className="ag-page">
      {/* ── Header ── */}
      <header className="ag-header">
        <span className="ag-header-title">Agents</span>
        <span className="ag-header-count">{totalCount} agents</span>
        <div className="ag-header-spacer" />
        <div className="ag-header-search-wrap">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <circle cx="6" cy="6" r="4.5" stroke="rgba(255,255,255,0.3)" strokeWidth="1.2" />
            <path d="M9.5 9.5L12 12" stroke="rgba(255,255,255,0.3)" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
          <input
            className="ag-header-search"
            type="text"
            placeholder="Search agents…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <button className="ag-spawn-btn">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          Spawn Agent
        </button>
      </header>

      {/* ── Stats Bar ── */}
      <div className="ag-stats-bar">
        <div className="ag-stat-card">
          <div className="ag-stat-label">Active Agents</div>
          <div className="ag-stat-value cyan">
            {activeCount}{" "}
            <span style={{ fontSize: "13px", fontWeight: 500, color: "var(--text-3)" }}>
              of {totalCount}
            </span>
          </div>
          <div className="ag-stat-sub">
            <span className="up">+{activeCount}</span> active now
          </div>
        </div>
        <div className="ag-stat-card">
          <div className="ag-stat-label">Tasks Completed (24h)</div>
          <div className="ag-stat-value emerald">
            {agentActivity.filter((e) => e.eventType === "done").length}
          </div>
          <div className="ag-stat-sub">based on session activity</div>
        </div>
        <div className="ag-stat-card">
          <div className="ag-stat-label">Avg Response Time</div>
          <div className="ag-stat-value violet">—</div>
          <div className="ag-stat-sub">median across all agents</div>
        </div>
        <div className="ag-stat-card">
          <div className="ag-stat-label">Delegation Depth</div>
          <div className="ag-stat-value amber">{activeCount > 1 ? 2 : 1}</div>
          <div className="ag-stat-sub">active agent hierarchy</div>
        </div>
      </div>

      {/* ── Tab Bar ── */}
      <div className="ag-tab-bar">
        <button
          className={`ag-tab-btn${activeTab === "command" ? " active" : ""}`}
          onClick={() => setActiveTab("command")}
        >
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
            <rect x="1" y="1" width="4.5" height="4.5" rx="1.2" stroke="currentColor" strokeWidth="1.3" />
            <rect x="7.5" y="1" width="4.5" height="4.5" rx="1.2" stroke="currentColor" strokeWidth="1.3" />
            <rect x="1" y="7.5" width="4.5" height="4.5" rx="1.2" stroke="currentColor" strokeWidth="1.3" />
            <rect x="7.5" y="7.5" width="4.5" height="4.5" rx="1.2" stroke="currentColor" strokeWidth="1.3" />
          </svg>
          Command Center
          <span className="ag-tab-badge">{totalCount}</span>
        </button>
        <button
          className={`ag-tab-btn${activeTab === "orbital" ? " active" : ""}`}
          onClick={() => setActiveTab("orbital")}
        >
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
            <circle cx="6.5" cy="6.5" r="5.5" stroke="currentColor" strokeWidth="1.3" />
            <circle cx="6.5" cy="6.5" r="2.5" stroke="currentColor" strokeWidth="1.3" />
            <circle cx="6.5" cy="6.5" r="1" fill="currentColor" />
          </svg>
          Orbital View
          <span className="ag-tab-badge">{activeCount} active</span>
        </button>
      </div>

      {/* ── Tab Views ── */}
      {activeTab === "command" && (
        <CommandCenterView
          agents={filteredAgents}
          agentActivity={agentActivity}
        />
      )}
      {activeTab === "orbital" && (
        <OrbitalView
          agents={filteredAgents}
          agentActivity={agentActivity}
        />
      )}
    </div>
  );
}

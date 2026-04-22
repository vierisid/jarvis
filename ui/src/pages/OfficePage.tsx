import React, { useState, useEffect, useCallback, useRef } from "react";
import { api } from "../hooks/useApi";
import type { AgentActivityEvent } from "../hooks/useWebSocket";
import CommandCenterView from "../components/office/CommandCenterView";
import OrbitalView from "../components/office/OrbitalView";
import AgentBuilderView from "../components/office/AgentBuilderView";
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

type TabId = "command" | "orbital" | "builder";
type SpecialistInfo = {
  id: string;
  name: string;
  description: string;
  authority_level: number;
  tools: string[];
};

export default function OfficePage({ agentActivity }: Props) {
  const [liveAgents, setLiveAgents] = useState<LiveAgentInfo[]>([]);
  const [specialists, setSpecialists] = useState<SpecialistInfo[]>([]);
  const [activeTab, setActiveTab] = useState<TabId>("command");
  const [search, setSearch] = useState("");
  const [spawnOpen, setSpawnOpen] = useState(false);
  const [spawning, setSpawning] = useState(false);
  const [spawnMessage, setSpawnMessage] = useState<{ text: string; type: "error" | "success" } | null>(null);
  const [selectedSpecialist, setSelectedSpecialist] = useState("software-engineer");
  const [spawnTask, setSpawnTask] = useState("");
  const [spawnContext, setSpawnContext] = useState("");
  const dialogRef = useRef<HTMLDivElement | null>(null);

  const fetchAgents = useCallback(async () => {
    try {
      const data = await api<LiveAgentInfo[]>("/api/agents");
      setLiveAgents(data);
    } catch {
      /* keep previous */
    }
  }, []);

  const fetchSpecialists = useCallback(async () => {
    try {
      const data = await api<{ specialists: SpecialistInfo[] }>("/api/agents/specialists");
      setSpecialists(data.specialists);
      if (data.specialists.length > 0) {
        setSelectedSpecialist((prev) => (
          data.specialists.some((specialist) => specialist.id === prev)
            ? prev
            : data.specialists[0]!.id
        ));
      }
    } catch {
      /* keep previous */
    }
  }, []);

  useEffect(() => {
    fetchAgents();
    fetchSpecialists();
    const interval = setInterval(fetchAgents, 5000);
    return () => clearInterval(interval);
  }, [fetchAgents, fetchSpecialists]);

  useEffect(() => {
    if (!spawnMessage) return;
    const timer = setTimeout(() => setSpawnMessage(null), 4000);
    return () => clearTimeout(timer);
  }, [spawnMessage]);

  useEffect(() => {
    if (spawnOpen) dialogRef.current?.focus();
  }, [spawnOpen]);

  useEffect(() => {
    if (!spawnOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !spawning) setSpawnOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [spawnOpen, spawning]);

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
  const activeCount = allAgents.filter((a) => a.isPrimary || a.live?.busy).length;
  const totalCount = AGENT_ROSTER.length;

  const selectedSpecialistMeta = specialists.find((specialist) => specialist.id === selectedSpecialist) ?? null;

  const handleSpawn = async () => {
    setSpawning(true);
    setSpawnMessage(null);
    try {
      const result = await api<{ assignment?: { message?: string } | null }>("/api/agents", {
        method: "POST",
        body: JSON.stringify({
          specialist: selectedSpecialist,
          task: spawnTask.trim() || undefined,
          context: spawnContext.trim() || undefined,
        }),
      });
      setSpawnMessage({
        text: result.assignment?.message ?? "Agent spawned successfully.",
        type: "success",
      });
      setSpawnTask("");
      setSpawnContext("");
      setSpawnOpen(false);
      fetchAgents();
    } catch (err) {
      setSpawnMessage({
        text: err instanceof Error ? err.message : "Failed to spawn agent.",
        type: "error",
      });
    } finally {
      setSpawning(false);
    }
  };

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
        <button className="ag-spawn-btn" onClick={() => setSpawnOpen(true)}>
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
        <button
          className={`ag-tab-btn${activeTab === "builder" ? " active" : ""}`}
          onClick={() => setActiveTab("builder")}
        >
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
            <rect x="1.2" y="2" width="3" height="3" rx="0.8" stroke="currentColor" strokeWidth="1.2" />
            <rect x="8.8" y="2" width="3" height="3" rx="0.8" stroke="currentColor" strokeWidth="1.2" />
            <rect x="5" y="8" width="3" height="3" rx="0.8" stroke="currentColor" strokeWidth="1.2" />
            <path d="M4.2 3.5h4.6M6.5 5v3" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
          </svg>
          Agent Builder
          <span className="ag-tab-badge">beta</span>
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
      {activeTab === "builder" && <AgentBuilderView specialists={specialists} />}

      {spawnMessage && (
        <div
          role="status"
          aria-live="polite"
          className={`ag-spawn-toast${spawnMessage.type === "error" ? " error" : ""}`}
        >
          {spawnMessage.text}
        </div>
      )}

      {spawnOpen && (
        <div
          className="ag-spawn-overlay"
          onClick={() => !spawning && setSpawnOpen(false)}
        >
          <div
            ref={dialogRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-labelledby="spawn-dialog-title"
            className="ag-spawn-dialog"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="ag-spawn-dialog-header">
              <div>
                <div id="spawn-dialog-title" className="ag-spawn-dialog-title">Spawn Agent</div>
                <div className="ag-spawn-dialog-subtitle">
                  Create a persistent specialist and optionally assign a task immediately.
                </div>
              </div>
              <button
                type="button"
                onClick={() => setSpawnOpen(false)}
                disabled={spawning}
                aria-label="Close"
                className="ag-spawn-dialog-close"
              >
                ×
              </button>
            </div>

            <div className="ag-spawn-dialog-body">
              <div className="ag-spawn-field-label">
                Specialist
                <div className="ag-spawn-specialist-list">
                  {specialists.map((specialist) => (
                    <button
                      key={specialist.id}
                      type="button"
                      onClick={() => setSelectedSpecialist(specialist.id)}
                      className={`ag-spawn-specialist-btn${selectedSpecialist === specialist.id ? " selected" : ""}`}
                    >
                      {specialist.name}
                    </button>
                  ))}
                </div>
              </div>

              {selectedSpecialistMeta && (
                <div className="ag-spawn-specialist-meta">
                  {selectedSpecialistMeta.description}
                  {" · "}Auth {selectedSpecialistMeta.authority_level} · {selectedSpecialistMeta.tools.length} tools
                </div>
              )}

              <label className="ag-spawn-field-label">
                Task
                <textarea
                  value={spawnTask}
                  onChange={(e) => setSpawnTask(e.target.value)}
                  rows={2}
                  placeholder="Optional. Leave blank to spawn the agent in idle mode."
                  className="ag-spawn-field-input"
                  style={{ minHeight: "60px" }}
                />
              </label>

              <label className="ag-spawn-field-label">
                Context
                <textarea
                  value={spawnContext}
                  onChange={(e) => setSpawnContext(e.target.value)}
                  rows={2}
                  placeholder="Optional background context for the task."
                  className="ag-spawn-field-input"
                  style={{ minHeight: "48px" }}
                />
              </label>
            </div>

            <div className="ag-spawn-dialog-footer">
              <button
                type="button"
                onClick={() => setSpawnOpen(false)}
                disabled={spawning}
                className="ag-spawn-btn-secondary"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSpawn}
                disabled={spawning || !selectedSpecialistMeta}
                className="ag-spawn-btn-primary"
              >
                {spawning ? "Spawning..." : spawnTask.trim() ? "Spawn And Assign" : "Spawn Agent"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

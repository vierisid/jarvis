import { useState, useEffect, useCallback } from "react";
import type { GoalEvent } from "../hooks/useWebSocket";
import { GoalKanban } from "../components/goals/GoalKanban";
import { GoalTimeline } from "../components/goals/GoalTimeline";
import { GoalMetrics } from "../components/goals/GoalMetrics";
import { GoalDetail } from "../components/goals/GoalDetail";
import { GoalCreateModal } from "../components/goals/GoalCreateModal";

export type Goal = {
  id: string;
  parent_id: string | null;
  level: string;
  title: string;
  description: string;
  success_criteria: string;
  time_horizon: string;
  score: number;
  score_reason: string | null;
  status: string;
  health: string;
  deadline: number | null;
  started_at: number | null;
  estimated_hours: number | null;
  actual_hours: number;
  authority_level: number;
  tags: string[];
  dependencies: string[];
  escalation_stage: string;
  escalation_started_at: number | null;
  sort_order: number;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
};

type Tab = "kanban" | "timeline" | "metrics";

type Props = {
  goalEvents: GoalEvent[];
};

export default function GoalsPage({ goalEvents }: Props) {
  const [tab, setTab] = useState<Tab>("kanban");
  const [goals, setGoals] = useState<Goal[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedGoal, setSelectedGoal] = useState<Goal | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const fetchGoals = useCallback(async () => {
    try {
      const resp = await fetch("/api/goals?limit=200");
      if (resp.ok) {
        const data = await resp.json();
        setGoals(data);
      }
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { fetchGoals(); }, [fetchGoals]);

  // Re-fetch on goal events
  useEffect(() => {
    if (goalEvents.length > 0) fetchGoals();
  }, [goalEvents.length, fetchGoals]);

  const handleSelect = (goal: Goal) => setSelectedGoal(goal);
  const handleClose = () => setSelectedGoal(null);

  const handleCreated = () => {
    setShowCreate(false);
    fetchGoals();
  };

  const handleUpdated = () => {
    fetchGoals();
    if (selectedGoal) {
      fetch(`/api/goals/${selectedGoal.id}`)
        .then(r => r.ok ? r.json() : null)
        .then(g => { if (g) setSelectedGoal(g); else setSelectedGoal(null); })
        .catch(() => setSelectedGoal(null));
    }
  };

  if (loading) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--j-text-dim)" }}>
        Loading goals...
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {/* Header */}
      <div style={{
        padding: "16px 24px",
        borderBottom: "1px solid var(--j-border)",
        display: "flex",
        alignItems: "center",
        gap: "16px",
        flexShrink: 0,
      }}>
        <div>
          <h1 style={{ fontSize: "20px", fontWeight: 600, color: "var(--j-text)", margin: 0 }}>Goals</h1>
          <div style={{ fontSize: "12px", color: "var(--j-text-muted)", marginTop: "2px" }}>
            OKR-style goal tracking with 0.0-1.0 scoring
          </div>
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", gap: "4px", marginLeft: "24px" }}>
          <TabBtn label="Kanban" tab="kanban" active={tab} onClick={setTab} />
          <TabBtn label="Timeline" tab="timeline" active={tab} onClick={setTab} />
          <TabBtn label="Metrics" tab="metrics" active={tab} onClick={setTab} />
        </div>

        <button
          onClick={() => setShowCreate(true)}
          style={{
            marginLeft: "auto",
            padding: "6px 16px",
            borderRadius: "6px",
            border: "1px solid var(--j-accent)",
            background: "rgba(0, 212, 255, 0.1)",
            color: "var(--j-accent)",
            fontSize: "13px",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          + New Goal
        </button>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: "hidden", display: "flex" }}>
        <div style={{ flex: 1, overflow: "auto" }}>
          {tab === "kanban" && <GoalKanban goals={goals} onSelect={handleSelect} onRefresh={fetchGoals} />}
          {tab === "timeline" && <GoalTimeline goals={goals} onSelect={handleSelect} />}
          {tab === "metrics" && <GoalMetrics goals={goals} />}
        </div>

        {/* Detail Panel */}
        {selectedGoal && (
          <GoalDetail goal={selectedGoal} onClose={handleClose} onUpdated={handleUpdated} />
        )}
      </div>

      {/* Create Modal */}
      {showCreate && (
        <GoalCreateModal onClose={() => setShowCreate(false)} onCreated={handleCreated} />
      )}
    </div>
  );
}

function TabBtn({ label, tab, active, onClick }: {
  label: string;
  tab: Tab;
  active: Tab;
  onClick: (t: Tab) => void;
}) {
  const isActive = tab === active;
  return (
    <button
      onClick={() => onClick(tab)}
      style={{
        padding: "6px 14px",
        borderRadius: "6px",
        border: "1px solid " + (isActive ? "var(--j-accent)" : "var(--j-border)"),
        background: isActive ? "rgba(0, 212, 255, 0.1)" : "transparent",
        color: isActive ? "var(--j-accent)" : "var(--j-text-dim)",
        fontSize: "12px",
        fontWeight: isActive ? 600 : 400,
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}

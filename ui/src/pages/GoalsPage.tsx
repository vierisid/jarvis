import { useState, useEffect, useCallback } from "react";
import type { GoalEvent } from "../hooks/useWebSocket";
import { GoalConstellation } from "../components/goals/GoalConstellation";
import { GoalTimeline } from "../components/goals/GoalTimeline";
import { GoalMetrics } from "../components/goals/GoalMetrics";
import { GoalDetail } from "../components/goals/GoalDetail";
import { GoalCreateModal } from "../components/goals/GoalCreateModal";
import "../styles/goals.css";

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

type Tab = "constellation" | "timeline" | "metrics";

type Props = {
  goalEvents: GoalEvent[];
};

export default function GoalsPage({ goalEvents }: Props) {
  const [tab, setTab] = useState<Tab>("constellation");
  const [goals, setGoals] = useState<Goal[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedGoal, setSelectedGoal] = useState<Goal | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [createInitialText, setCreateInitialText] = useState("");

  const openCreate = (prefill = "") => {
    setCreateInitialText(prefill);
    setShowCreate(true);
  };

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
        .then((r) => (r.ok ? r.json() : null))
        .then((g) => { if (g) setSelectedGoal(g); else setSelectedGoal(null); })
        .catch(() => setSelectedGoal(null));
    }
  };

  const activeCount = goals.filter((g) => g.status === "active").length;

  return (
    <div className="goals-page">
      {/* 3-layer atmosphere */}
      <div className="goals-atmos" aria-hidden="true">
        <div className="goals-atmos-aurora" />
        <div className="goals-atmos-dots" />
      </div>

      {/* Header — always rendered */}
      <header className="goals-header">
        {/* View tabs */}
        <nav className="goals-view-tabs" aria-label="Goal views">
          <button
            className={`goals-view-tab${tab === "constellation" ? " active" : ""}`}
            onClick={() => setTab("constellation")}
            aria-current={tab === "constellation" ? "page" : undefined}
          >
            Constellation
          </button>
          <button
            className={`goals-view-tab${tab === "timeline" ? " active" : ""}`}
            onClick={() => setTab("timeline")}
            aria-current={tab === "timeline" ? "page" : undefined}
          >
            Timeline
          </button>
          <button
            className={`goals-view-tab${tab === "metrics" ? " active" : ""}`}
            onClick={() => setTab("metrics")}
            aria-current={tab === "metrics" ? "page" : undefined}
          >
            Metrics
          </button>
        </nav>

        <div className="goals-spacer" />

        {/* Search */}
        <button className="goals-search-btn" aria-label="Search goals" title="Search goals">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.4" />
            <line x1="9.5" y1="9.5" x2="12.5" y2="12.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>

        {/* New goal */}
        <button
          className="goals-new-btn"
          onClick={() => openCreate()}
          aria-label="Create a new goal"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <line x1="6" y1="1" x2="6" y2="11" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            <line x1="1" y1="6" x2="11" y2="6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          New Goal
        </button>
      </header>

      {/* Content area */}
      {loading ? (
        <div className="goals-loading" role="status" aria-label="Loading goals">
          <div className="goals-loading-orb" aria-hidden="true" />
          <span className="goals-loading-text">Loading goals...</span>
        </div>
      ) : goals.length === 0 ? (
        <EmptyState onCreateClick={openCreate} />
      ) : (
        <div className="goals-body">
          <div className="goals-content">
            {tab === "constellation" && (
              <GoalConstellation
                goals={goals}
                onSelect={handleSelect}
                selectedGoalId={selectedGoal?.id}
              />
            )}
            {tab === "timeline" && (
              <GoalTimeline goals={goals} onSelect={handleSelect} />
            )}
            {tab === "metrics" && (
              <GoalMetrics goals={goals} />
            )}
          </div>

          {/* Detail panel */}
          {selectedGoal && (
            <GoalDetail
              goal={selectedGoal}
              onClose={handleClose}
              onUpdated={handleUpdated}
            />
          )}
        </div>
      )}

      {/* Create modal overlay */}
      {showCreate && (
        <GoalCreateModal
          onClose={() => setShowCreate(false)}
          onCreated={handleCreated}
          initialText={createInitialText}
        />
      )}
    </div>
  );
}

/* ----------------------------------------------------------------
   Empty state sub-component
   ---------------------------------------------------------------- */
type EmptyStateProps = {
  onCreateClick: (prefill?: string) => void;
};

function EmptyState({ onCreateClick }: EmptyStateProps) {
  const suggestions = [
    {
      label: "I want to launch a product",
      icon: (
        <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true">
          <path d="M5.5 1L6.8 4.2H10L7.4 6.2L8.5 9.5L5.5 7.8L2.5 9.5L3.6 6.2L1 4.2H4.2L5.5 1Z" fill="var(--violet-bright)" opacity="0.7" />
        </svg>
      ),
    },
    {
      label: "Get in shape this year",
      icon: (
        <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true">
          <circle cx="5.5" cy="5.5" r="4" stroke="var(--blue)" strokeWidth="1.2" />
        </svg>
      ),
    },
    {
      label: "Learn a new skill",
      icon: (
        <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true">
          <rect x="1" y="1" width="9" height="9" rx="2" stroke="var(--emerald)" strokeWidth="1.2" />
        </svg>
      ),
    },
    {
      label: "Hit Q2 targets",
      icon: (
        <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true">
          <line x1="1" y1="5.5" x2="10" y2="5.5" stroke="var(--amber)" strokeWidth="1.3" strokeLinecap="round" />
          <line x1="5.5" y1="1" x2="5.5" y2="10" stroke="var(--amber)" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      ),
    },
  ];

  return (
    <div className="goals-empty" role="status" aria-label="No goals yet">
      {/* Ghost orbit rings */}
      <div className="goals-empty-ring" style={{ width: 200, height: 200, animationDelay: "0s" }} aria-hidden="true" />
      <div className="goals-empty-ring" style={{ width: 340, height: 340, animationDelay: "1s", borderColor: "rgba(139,92,246,0.05)" }} aria-hidden="true" />
      <div className="goals-empty-ring" style={{ width: 500, height: 500, animationDelay: "2s", borderColor: "rgba(96,165,250,0.04)" }} aria-hidden="true" />

      {/* Hint dots */}
      <div className="goals-empty-hint-dot" style={{ top: "calc(50% - 80px)", left: "calc(50% + 60px)", animationDelay: "0s" }} aria-hidden="true" />
      <div className="goals-empty-hint-dot" style={{ top: "calc(50% + 40px)", left: "calc(50% - 90px)", animationDelay: "1s", background: "rgba(96,165,250,0.3)" }} aria-hidden="true" />
      <div className="goals-empty-hint-dot" style={{ top: "calc(50% - 50px)", left: "calc(50% - 110px)", animationDelay: "2s", background: "rgba(52,211,153,0.3)" }} aria-hidden="true" />
      <div className="goals-empty-hint-dot" style={{ top: "calc(50% + 90px)", left: "calc(50% + 80px)", animationDelay: "0.5s", background: "rgba(251,191,36,0.25)" }} aria-hidden="true" />

      {/* Central breathing orb */}
      <div className="goals-empty-orb" aria-hidden="true">
        <div className="goals-empty-orb-inner" />
      </div>

      <h2 className="goals-empty-title">No goals yet</h2>
      <p className="goals-empty-desc">
        Create your first goal to watch the constellation form.
      </p>

      <button className="goals-empty-cta" onClick={() => onCreateClick()}>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <line x1="7" y1="1" x2="7" y2="13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          <line x1="1" y1="7" x2="13" y2="7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
        + Create Goal
      </button>

      {/* Suggestion pills */}
      <div className="goals-empty-pills" role="list" aria-label="Goal suggestions">
        {suggestions.map(({ label, icon }) => (
          <button
            key={label}
            className="goals-empty-pill"
            onClick={() => onCreateClick(label)}
            role="listitem"
            aria-label={`Suggested goal: ${label}`}
          >
            {icon}
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

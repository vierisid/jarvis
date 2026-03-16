import { useState, useEffect } from "react";
import { api } from "../../hooks/useApi";
import type { Goal } from "../../pages/GoalsPage";

type Props = {
  goal: Goal;
  onClose: () => void;
  onUpdated: () => void;
};

type ProgressEntry = {
  id: string;
  goal_id: string;
  type: string;
  score_before: number;
  score_after: number;
  note: string;
  source: string;
  created_at: number;
};

// ----------------------------------------------------------------
// Static lookup maps
// ----------------------------------------------------------------

const LEVEL_BADGE_COLORS: Record<string, { bg: string; color: string; border: string }> = {
  objective:    { bg: "var(--violet-aura)",           color: "var(--violet-bright)", border: "rgba(139,92,246,0.20)" },
  key_result:   { bg: "rgba(96,165,250,0.06)",         color: "var(--blue)",          border: "rgba(96,165,250,0.20)" },
  milestone:    { bg: "rgba(52,211,153,0.06)",         color: "var(--emerald)",       border: "rgba(52,211,153,0.20)" },
  task:         { bg: "rgba(251,191,36,0.06)",         color: "var(--amber)",         border: "rgba(251,191,36,0.20)" },
  daily_action: { bg: "rgba(34,211,238,0.06)",         color: "var(--cyan)",          border: "rgba(34,211,238,0.20)" },
};

const LEVEL_DOT_COLORS: Record<string, string> = {
  objective:    "var(--violet)",
  key_result:   "var(--blue)",
  milestone:    "var(--emerald)",
  task:         "var(--amber)",
  daily_action: "var(--cyan)",
};

const HEALTH_DOT_COLORS: Record<string, string> = {
  on_track: "var(--emerald)",
  at_risk:  "var(--amber)",
  behind:   "var(--orange)",
  critical: "var(--rose)",
};

const statusOptions = ["draft", "active", "paused", "completed", "failed", "killed"];
const healthOptions = ["on_track", "at_risk", "behind", "critical"];

const CIRC = 2 * Math.PI * 26; // circumference for r=26

export function GoalDetail({ goal, onClose, onUpdated }: Props) {
  const [editingTitle, setEditingTitle]       = useState(false);
  const [titleValue, setTitleValue]           = useState(goal.title);
  const [editingDesc, setEditingDesc]         = useState(false);
  const [descValue, setDescValue]             = useState(goal.description);
  const [editingCriteria, setEditingCriteria] = useState(false);
  const [criteriaValue, setCriteriaValue]     = useState(goal.success_criteria);
  const [scoreValue, setScoreValue]           = useState(goal.score);
  const [scoreReason, setScoreReason]         = useState("");
  const [showScoreInput, setShowScoreInput]   = useState(false);
  const [children, setChildren]               = useState<Goal[]>([]);
  const [progress, setProgress]               = useState<ProgressEntry[]>([]);
  const [saving, setSaving]                   = useState(false);
  const [confirmDelete, setConfirmDelete]     = useState(false);

  // Reset local state when a different goal is selected
  useEffect(() => {
    setTitleValue(goal.title);
    setDescValue(goal.description);
    setCriteriaValue(goal.success_criteria);
    setScoreValue(goal.score);
    setEditingTitle(false);
    setEditingDesc(false);
    setEditingCriteria(false);
    setShowScoreInput(false);
    setConfirmDelete(false);
  }, [goal.id]);

  // Fetch children and progress history
  useEffect(() => {
    fetch(`/api/goals/${goal.id}/children`)
      .then(r => r.json())
      .then(setChildren)
      .catch(() => setChildren([]));
    fetch(`/api/goals/${goal.id}/progress?limit=20`)
      .then(r => r.json())
      .then(setProgress)
      .catch(() => setProgress([]));
  }, [goal.id]);

  // ----------------------------------------------------------------
  // API helpers
  // ----------------------------------------------------------------

  const saveField = async (field: string, value: unknown) => {
    setSaving(true);
    try {
      await api(`/api/goals/${goal.id}`, {
        method: "PATCH",
        body: JSON.stringify({ [field]: value }),
      });
      onUpdated();
    } catch { /* ignore */ }
    setSaving(false);
  };

  const handleTitleSave = () => {
    setEditingTitle(false);
    if (titleValue.trim() && titleValue !== goal.title) {
      saveField("title", titleValue.trim());
    }
  };

  const handleDescSave = () => {
    setEditingDesc(false);
    if (descValue !== goal.description) {
      saveField("description", descValue);
    }
  };

  const handleCriteriaSave = () => {
    setEditingCriteria(false);
    if (criteriaValue !== goal.success_criteria) {
      saveField("success_criteria", criteriaValue);
    }
  };

  const handleScoreSave = async () => {
    setShowScoreInput(false);
    if (scoreValue !== goal.score) {
      setSaving(true);
      try {
        await api(`/api/goals/${goal.id}/score`, {
          method: "POST",
          body: JSON.stringify({ score: scoreValue, reason: scoreReason || "Manual update", source: "user" }),
        });
        setScoreReason("");
        onUpdated();
      } catch { /* ignore */ }
      setSaving(false);
    }
  };

  const handleStatusChange = async (status: string) => {
    setSaving(true);
    try {
      await api(`/api/goals/${goal.id}/status`, {
        method: "POST",
        body: JSON.stringify({ status }),
      });
      onUpdated();
    } catch { /* ignore */ }
    setSaving(false);
  };

  const handleHealthChange = async (health: string) => {
    setSaving(true);
    try {
      await api(`/api/goals/${goal.id}/health`, {
        method: "POST",
        body: JSON.stringify({ health }),
      });
      onUpdated();
    } catch { /* ignore */ }
    setSaving(false);
  };

  const handleDelete = async () => {
    try {
      await api(`/api/goals/${goal.id}`, { method: "DELETE" });
      onClose();
      onUpdated();
    } catch { /* ignore */ }
  };

  // ----------------------------------------------------------------
  // Computed values
  // ----------------------------------------------------------------

  const daysLeft = goal.deadline
    ? Math.ceil((goal.deadline - Date.now()) / 86400000)
    : null;

  const levelBadge = LEVEL_BADGE_COLORS[goal.level] ?? LEVEL_BADGE_COLORS.task;
  const levelLabel = goal.level.replace(/_/g, " ").toUpperCase();

  const scoreOffset = CIRC * (1 - goal.score);
  const scorePercent = Math.round(goal.score * 100);

  // ----------------------------------------------------------------
  // Render
  // ----------------------------------------------------------------

  return (
    <div className="goals-detail">
      <div className="goals-detail-scroll">

        {/* Top bar: level badge + close */}
        <div className="goals-detail-top">
          <div
            className="goals-detail-level-badge"
            style={levelBadge ? { background: levelBadge.bg, color: levelBadge.color, borderColor: levelBadge.border } : undefined}
          >
            {levelLabel}
          </div>
          <button className="goals-detail-close" onClick={onClose} aria-label="Close detail panel">
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
              <line x1="1" y1="1" x2="9" y2="9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              <line x1="9" y1="1" x2="1" y2="9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </button>
        </div>

        {/* Title — editable */}
        {editingTitle ? (
          <input
            className="goals-edit-input"
            value={titleValue}
            onChange={e => setTitleValue(e.target.value)}
            onBlur={handleTitleSave}
            onKeyDown={e => e.key === "Enter" && handleTitleSave()}
            autoFocus
            aria-label="Edit goal title"
          />
        ) : (
          <div
            className="goals-detail-title"
            onClick={() => setEditingTitle(true)}
            title="Click to edit title"
            role="button"
            tabIndex={0}
            onKeyDown={e => e.key === "Enter" && setEditingTitle(true)}
          >
            {goal.title}
          </div>
        )}

        {/* Meta row: health, status, deadline, escalation, saving */}
        <div className="goals-meta-row">
          <div className={`goals-meta-badge health-${goal.health}`}>
            <div
              className="goals-meta-dot"
              style={{ background: HEALTH_DOT_COLORS[goal.health] ?? "var(--text-3)" }}
            />
            {goal.health.replace(/_/g, " ").toUpperCase()}
          </div>

          <div className={`goals-meta-badge status-${goal.status}`}>
            {goal.status.toUpperCase()}
          </div>

          {daysLeft !== null && (
            <div
              className={`goals-meta-badge ${
                daysLeft < 0 ? "deadline-overdue" : daysLeft < 7 ? "deadline-warning" : "deadline"
              }`}
            >
              <svg width="9" height="9" viewBox="0 0 9 9" fill="none" aria-hidden="true">
                <circle cx="4.5" cy="4.5" r="3.5" stroke="currentColor" strokeWidth="1"/>
                <line x1="4.5" y1="2.5" x2="4.5" y2="4.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
                <line x1="4.5" y1="4.5" x2="6" y2="5.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
              </svg>
              {daysLeft < 0 ? `${Math.abs(daysLeft)}d overdue` : `${daysLeft}d left`}
            </div>
          )}

          {goal.escalation_stage !== "none" && (
            <div className="goals-meta-badge escalation">
              {goal.escalation_stage.replace(/_/g, " ").toUpperCase()}
            </div>
          )}

          {saving && <span className="goals-saving-text">Saving...</span>}
        </div>

        {/* Score section */}
        <div className="goals-score-section">
          <div className="goals-score-ring-wrap">
            <svg width="64" height="64" viewBox="0 0 64 64" aria-hidden="true">
              <circle cx="32" cy="32" r="26" fill="none" stroke="rgba(139,92,246,0.12)" strokeWidth="4"/>
              <circle
                cx="32" cy="32" r="26" fill="none" stroke="var(--violet)" strokeWidth="4"
                strokeDasharray={`${CIRC} ${CIRC}`}
                strokeDashoffset={scoreOffset}
                strokeLinecap="round"
              />
            </svg>
            <div className="goals-score-center">{goal.score.toFixed(2)}</div>
          </div>

          <div className="goals-score-info">
            <div className="goals-score-label">OVERALL SCORE</div>
            <div
              className="goals-score-value"
              onClick={() => setShowScoreInput(v => !v)}
              role="button"
              tabIndex={0}
              onKeyDown={e => e.key === "Enter" && setShowScoreInput(v => !v)}
              title="Click to update score"
              aria-label={`Score ${scorePercent}%. Click to update.`}
            >
              {scorePercent}%
            </div>
            {goal.score_reason && (
              <div className="goals-score-reason">{goal.score_reason}</div>
            )}

            {/* Inline score editor */}
            {showScoreInput && (
              <div className="goals-score-input-section">
                <div className="goals-score-slider-row">
                  <input
                    type="range"
                    className="goals-score-slider"
                    min="0"
                    max="1"
                    step="0.05"
                    value={scoreValue}
                    onChange={e => setScoreValue(parseFloat(e.target.value))}
                    aria-label="Score slider"
                  />
                  <span className="goals-score-slider-val">{scoreValue.toFixed(2)}</span>
                </div>
                <input
                  type="text"
                  className="goals-score-reason-input"
                  placeholder="Reason for score change..."
                  value={scoreReason}
                  onChange={e => setScoreReason(e.target.value)}
                  aria-label="Score change reason"
                />
                <div className="goals-score-btn-row">
                  <button
                    className="goals-btn-secondary"
                    onClick={() => setShowScoreInput(false)}
                  >
                    Cancel
                  </button>
                  <button
                    className="goals-btn-primary"
                    onClick={handleScoreSave}
                  >
                    Update Score
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Description */}
        <div className="goals-detail-section">
          <div className="goals-detail-section-label">DESCRIPTION</div>
          {editingDesc ? (
            <textarea
              className="goals-edit-textarea"
              value={descValue}
              onChange={e => setDescValue(e.target.value)}
              onBlur={handleDescSave}
              rows={4}
              autoFocus
              aria-label="Edit description"
            />
          ) : (
            <div
              className={`goals-detail-text${!goal.description ? " empty" : ""}`}
              onClick={() => setEditingDesc(true)}
              role="button"
              tabIndex={0}
              onKeyDown={e => e.key === "Enter" && setEditingDesc(true)}
              title="Click to edit description"
            >
              {goal.description || "Click to add description"}
            </div>
          )}
        </div>

        {/* Success Criteria */}
        <div className="goals-detail-section">
          <div className="goals-detail-section-label">SUCCESS CRITERIA</div>
          {editingCriteria ? (
            <textarea
              className="goals-edit-textarea"
              value={criteriaValue}
              onChange={e => setCriteriaValue(e.target.value)}
              onBlur={handleCriteriaSave}
              rows={3}
              autoFocus
              aria-label="Edit success criteria"
            />
          ) : (
            <div
              className={`goals-detail-text${!goal.success_criteria ? " empty" : ""}`}
              onClick={() => setEditingCriteria(true)}
              role="button"
              tabIndex={0}
              onKeyDown={e => e.key === "Enter" && setEditingCriteria(true)}
              title="Click to edit success criteria"
            >
              {goal.success_criteria || "Click to add success criteria"}
            </div>
          )}
        </div>

        {/* Status & Health */}
        <div className="goals-detail-section">
          <div className="goals-detail-section-label">STATUS &amp; HEALTH</div>
          <div className="goals-select-row">
            <div className="goals-select-group">
              <label className="goals-select-label" htmlFor={`status-${goal.id}`}>STATUS</label>
              <select
                id={`status-${goal.id}`}
                className="goals-select"
                value={goal.status}
                onChange={e => handleStatusChange(e.target.value)}
              >
                {statusOptions.map(s => (
                  <option key={s} value={s}>{s.replace(/_/g, " ")}</option>
                ))}
              </select>
            </div>
            <div className="goals-select-group">
              <label className="goals-select-label" htmlFor={`health-${goal.id}`}>HEALTH</label>
              <select
                id={`health-${goal.id}`}
                className="goals-select"
                value={goal.health}
                onChange={e => handleHealthChange(e.target.value)}
              >
                {healthOptions.map(h => (
                  <option key={h} value={h}>{h.replace(/_/g, " ")}</option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* Children */}
        {children.length > 0 && (
          <div className="goals-detail-section">
            <div className="goals-detail-section-label">CHILDREN ({children.length})</div>
            <div className="goals-children-list">
              {children.map(child => (
                <div key={child.id} className="goals-child-card">
                  <div
                    className="goals-child-dot"
                    style={{ background: LEVEL_DOT_COLORS[child.level] ?? "var(--text-3)" }}
                  />
                  <div className="goals-child-name">{child.title}</div>
                  <div className="goals-child-score">{child.score.toFixed(2)}</div>
                  <div
                    className="goals-child-health"
                    style={{ background: HEALTH_DOT_COLORS[child.health] ?? "var(--text-3)" }}
                  />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Score History */}
        {progress.length > 0 && (
          <div className="goals-detail-section">
            <div className="goals-detail-section-label">SCORE HISTORY</div>
            <div className="goals-progress-list">
              {progress.map(entry => {
                const delta = entry.score_after - entry.score_before;
                const isBaseline = entry.type === "baseline" || (delta === 0 && entry.note === "");
                const deltaStr = isBaseline
                  ? "baseline"
                  : (delta >= 0 ? "+" : "") + delta.toFixed(2);
                const dateStr = new Date(entry.created_at).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                });
                return (
                  <div key={entry.id} className="goals-progress-entry">
                    <div className={`goals-progress-dot${isBaseline ? " baseline" : ""}`} />
                    <div className={`goals-progress-change${isBaseline ? " baseline" : ""}`}>
                      {deltaStr}
                    </div>
                    <div className="goals-progress-desc">
                      {isBaseline
                        ? (entry.note || "Goal created, initial score set")
                        : `${entry.score_before.toFixed(2)} → ${entry.score_after.toFixed(2)}${entry.note ? ` — ${entry.note}` : ""}`
                      }
                    </div>
                    <div className="goals-progress-date">{dateStr}</div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Details grid */}
        <div className="goals-detail-section">
          <div className="goals-detail-section-label">DETAILS</div>
          <div className="goals-details-grid">
            <div className="goals-detail-item">
              <div className="goals-detail-item-label">TIME HORIZON</div>
              <div className="goals-detail-item-val">{goal.time_horizon.replace(/_/g, " ")}</div>
            </div>
            <div className="goals-detail-item">
              <div className="goals-detail-item-label">DEADLINE</div>
              <div className="goals-detail-item-val">
                {goal.deadline ? new Date(goal.deadline).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "None"}
              </div>
            </div>
            <div className="goals-detail-item">
              <div className="goals-detail-item-label">EST. HOURS</div>
              <div className="goals-detail-item-val">
                {goal.estimated_hours != null ? `${goal.estimated_hours} hrs` : "—"}
              </div>
            </div>
            <div className="goals-detail-item">
              <div className="goals-detail-item-label">ACTUAL HOURS</div>
              <div className="goals-detail-item-val accent">{goal.actual_hours.toFixed(1)} hrs</div>
            </div>
            <div className="goals-detail-item">
              <div className="goals-detail-item-label">TAGS</div>
              {goal.tags.length > 0 ? (
                <div className="goals-tags-list">
                  {goal.tags.map(t => (
                    <span key={t} className="goals-tag-pill">{t}</span>
                  ))}
                </div>
              ) : (
                <div className="goals-detail-item-val muted">None</div>
              )}
            </div>
            <div className="goals-detail-item">
              <div className="goals-detail-item-label">ESCALATION</div>
              <div className={`goals-detail-item-val${goal.escalation_stage === "none" ? "" : " muted"}`}
                style={goal.escalation_stage !== "none" ? { color: "var(--rose)" } : undefined}>
                {goal.escalation_stage === "none" ? "None" : goal.escalation_stage.replace(/_/g, " ")}
              </div>
            </div>
          </div>
        </div>

        {/* Parent link */}
        {goal.parent_id && (
          <div className="goals-parent-link">
            <span className="goals-parent-arrow">↑</span>
            <span>Parent goal</span>
          </div>
        )}

        {/* Danger zone */}
        <div className="goals-danger-zone">
          <div className="goals-danger-label">DANGER ZONE</div>
          {!confirmDelete ? (
            <button
              className="goals-delete-btn"
              onClick={() => setConfirmDelete(true)}
              aria-label="Delete this goal"
            >
              <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true">
                <rect x="1" y="3" width="9" height="7" rx="1" stroke="currentColor" strokeWidth="1.2"/>
                <line x1="4" y1="5" x2="4" y2="8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                <line x1="7" y1="5" x2="7" y2="8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                <line x1="0.5" y1="3" x2="10.5" y2="3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                <line x1="3.5" y1="1" x2="7.5" y2="1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
              </svg>
              Delete Goal
            </button>
          ) : (
            <>
              <div className="goals-delete-confirm-text">
                Are you sure? This will also delete all child goals.
              </div>
              <div className="goals-delete-confirm-row">
                <button
                  className="goals-btn-secondary"
                  onClick={() => setConfirmDelete(false)}
                >
                  Cancel
                </button>
                <button
                  className="goals-btn-danger"
                  onClick={handleDelete}
                  aria-label="Confirm goal deletion"
                >
                  Yes, Delete
                </button>
              </div>
            </>
          )}
        </div>

      </div>
    </div>
  );
}

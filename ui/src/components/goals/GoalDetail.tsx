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

const healthColors: Record<string, string> = {
  on_track: "var(--j-success)",
  at_risk: "var(--j-warning)",
  behind: "#f97316",
  critical: "var(--j-error)",
};

const statusOptions = ["draft", "active", "paused", "completed", "failed", "killed"];
const healthOptions = ["on_track", "at_risk", "behind", "critical"];
const levelIcons: Record<string, string> = {
  objective: "\u25C6",
  key_result: "\u25B8",
  milestone: "\u25A0",
  task: "\u25CB",
  daily_action: "\u2022",
};

function scoreColor(score: number): string {
  if (score >= 0.7) return "var(--j-success)";
  if (score >= 0.4) return "var(--j-warning)";
  if (score > 0) return "#f97316";
  return "var(--j-text-muted)";
}

export function GoalDetail({ goal, onClose, onUpdated }: Props) {
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleValue, setTitleValue] = useState(goal.title);
  const [editingDesc, setEditingDesc] = useState(false);
  const [descValue, setDescValue] = useState(goal.description);
  const [editingCriteria, setEditingCriteria] = useState(false);
  const [criteriaValue, setCriteriaValue] = useState(goal.success_criteria);
  const [scoreValue, setScoreValue] = useState(goal.score);
  const [scoreReason, setScoreReason] = useState("");
  const [showScoreInput, setShowScoreInput] = useState(false);
  const [children, setChildren] = useState<Goal[]>([]);
  const [progress, setProgress] = useState<ProgressEntry[]>([]);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    setTitleValue(goal.title);
    setDescValue(goal.description);
    setCriteriaValue(goal.success_criteria);
    setScoreValue(goal.score);
    setEditingTitle(false);
    setEditingDesc(false);
    setEditingCriteria(false);
    setShowScoreInput(false);
  }, [goal.id]);

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

  const daysLeft = goal.deadline
    ? Math.ceil((goal.deadline - Date.now()) / 86400000)
    : null;

  return (
    <div style={{
      width: "380px",
      minWidth: "380px",
      borderLeft: "1px solid var(--j-border)",
      display: "flex",
      flexDirection: "column",
      height: "100%",
      overflow: "hidden",
      background: "var(--j-bg)",
    }}>
      {/* Header */}
      <div style={{
        padding: "16px 20px",
        borderBottom: "1px solid var(--j-border)",
        flexShrink: 0,
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "8px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <span style={{ fontSize: "14px", color: "var(--j-text-muted)" }}>
              {levelIcons[goal.level] ?? ""}
            </span>
            <span style={{
              fontSize: "11px",
              textTransform: "capitalize",
              color: "var(--j-text-dim)",
              fontWeight: 600,
            }}>
              {goal.level.replace("_", " ")}
            </span>
          </div>
          <button
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              color: "var(--j-text-muted)",
              fontSize: "18px",
              cursor: "pointer",
              padding: "4px",
            }}
          >
            {"\u2715"}
          </button>
        </div>

        {/* Title */}
        {editingTitle ? (
          <input
            value={titleValue}
            onChange={(e) => setTitleValue(e.target.value)}
            onBlur={handleTitleSave}
            onKeyDown={(e) => e.key === "Enter" && handleTitleSave()}
            autoFocus
            style={{
              fontSize: "16px",
              fontWeight: 600,
              color: "var(--j-text)",
              background: "transparent",
              border: "none",
              borderBottom: "2px solid var(--j-accent)",
              outline: "none",
              width: "100%",
              padding: "0 0 4px 0",
              fontFamily: "inherit",
            }}
          />
        ) : (
          <h2
            onClick={() => setEditingTitle(true)}
            style={{
              fontSize: "16px",
              fontWeight: 600,
              color: "var(--j-text)",
              margin: 0,
              cursor: "text",
            }}
          >
            {goal.title}
          </h2>
        )}

        {/* Meta badges */}
        <div style={{ display: "flex", alignItems: "center", gap: "6px", marginTop: "8px", flexWrap: "wrap" }}>
          <span style={{
            fontSize: "10px",
            fontWeight: 600,
            padding: "2px 6px",
            borderRadius: "4px",
            background: `${healthColors[goal.health] ?? "var(--j-border)"}20`,
            color: healthColors[goal.health] ?? "var(--j-text-muted)",
            textTransform: "uppercase",
          }}>
            {goal.health.replace("_", " ")}
          </span>
          <span style={{
            fontSize: "10px",
            fontWeight: 600,
            padding: "2px 6px",
            borderRadius: "4px",
            background: "rgba(0, 212, 255, 0.1)",
            color: "var(--j-accent)",
            textTransform: "uppercase",
          }}>
            {goal.status}
          </span>
          {goal.escalation_stage !== "none" && (
            <span style={{
              fontSize: "10px",
              fontWeight: 600,
              padding: "2px 6px",
              borderRadius: "4px",
              background: "rgba(239, 68, 68, 0.15)",
              color: "var(--j-error)",
              textTransform: "uppercase",
            }}>
              {goal.escalation_stage.replace("_", " ")}
            </span>
          )}
          {daysLeft !== null && (
            <span style={{
              fontSize: "10px",
              color: daysLeft < 0 ? "var(--j-error)" : daysLeft < 7 ? "var(--j-warning)" : "var(--j-text-muted)",
            }}>
              {daysLeft < 0 ? `${Math.abs(daysLeft)}d overdue` : `${daysLeft}d left`}
            </span>
          )}
          {saving && <span style={{ fontSize: "10px", color: "var(--j-text-muted)" }}>Saving...</span>}
        </div>
      </div>

      {/* Scrollable content */}
      <div style={{ flex: 1, overflow: "auto", padding: "16px 20px", display: "flex", flexDirection: "column", gap: "16px" }}>
        {/* Score */}
        <Section title="Score">
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <div style={{
              flex: 1,
              height: "8px",
              background: "var(--j-border)",
              borderRadius: "4px",
              overflow: "hidden",
            }}>
              <div style={{
                width: `${goal.score * 100}%`,
                height: "100%",
                background: scoreColor(goal.score),
                borderRadius: "4px",
                transition: "width 0.3s",
              }} />
            </div>
            <span
              onClick={() => setShowScoreInput(true)}
              style={{
                fontSize: "16px",
                fontWeight: 700,
                color: scoreColor(goal.score),
                cursor: "pointer",
                minWidth: "40px",
                textAlign: "right",
              }}
            >
              {goal.score.toFixed(2)}
            </span>
          </div>
          {goal.score_reason && (
            <div style={{ fontSize: "11px", color: "var(--j-text-muted)", marginTop: "4px" }}>
              {goal.score_reason}
            </div>
          )}
          {showScoreInput && (
            <div style={{ marginTop: "8px", display: "flex", flexDirection: "column", gap: "6px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={scoreValue}
                  onChange={(e) => setScoreValue(parseFloat(e.target.value))}
                  style={{ flex: 1 }}
                />
                <span style={{ fontSize: "12px", color: "var(--j-text)", fontWeight: 600, minWidth: "32px" }}>
                  {scoreValue.toFixed(2)}
                </span>
              </div>
              <input
                type="text"
                placeholder="Reason for score change..."
                value={scoreReason}
                onChange={(e) => setScoreReason(e.target.value)}
                style={inputStyle}
              />
              <div style={{ display: "flex", gap: "6px", justifyContent: "flex-end" }}>
                <button onClick={() => setShowScoreInput(false)} style={btnSecondary}>Cancel</button>
                <button onClick={handleScoreSave} style={btnPrimary}>Update Score</button>
              </div>
            </div>
          )}
        </Section>

        {/* Status & Health */}
        <Section title="Status & Health">
          <div style={{ display: "flex", gap: "8px" }}>
            <div style={{ flex: 1 }}>
              <label style={labelStyle}>Status</label>
              <select
                value={goal.status}
                onChange={(e) => handleStatusChange(e.target.value)}
                style={inputStyle}
              >
                {statusOptions.map(s => (
                  <option key={s} value={s}>{s.replace("_", " ")}</option>
                ))}
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <label style={labelStyle}>Health</label>
              <select
                value={goal.health}
                onChange={(e) => handleHealthChange(e.target.value)}
                style={inputStyle}
              >
                {healthOptions.map(h => (
                  <option key={h} value={h}>{h.replace("_", " ")}</option>
                ))}
              </select>
            </div>
          </div>
        </Section>

        {/* Description */}
        <Section title="Description">
          {editingDesc ? (
            <textarea
              value={descValue}
              onChange={(e) => setDescValue(e.target.value)}
              onBlur={handleDescSave}
              rows={4}
              autoFocus
              style={{ ...inputStyle, resize: "vertical" }}
            />
          ) : (
            <div
              onClick={() => setEditingDesc(true)}
              style={{
                fontSize: "12px",
                color: goal.description ? "var(--j-text-dim)" : "var(--j-text-muted)",
                cursor: "text",
                minHeight: "32px",
                whiteSpace: "pre-wrap",
                fontStyle: goal.description ? "normal" : "italic",
              }}
            >
              {goal.description || "Click to add description"}
            </div>
          )}
        </Section>

        {/* Success Criteria */}
        <Section title="Success Criteria">
          {editingCriteria ? (
            <textarea
              value={criteriaValue}
              onChange={(e) => setCriteriaValue(e.target.value)}
              onBlur={handleCriteriaSave}
              rows={3}
              autoFocus
              style={{ ...inputStyle, resize: "vertical" }}
            />
          ) : (
            <div
              onClick={() => setEditingCriteria(true)}
              style={{
                fontSize: "12px",
                color: goal.success_criteria ? "var(--j-text-dim)" : "var(--j-text-muted)",
                cursor: "text",
                minHeight: "24px",
                whiteSpace: "pre-wrap",
                fontStyle: goal.success_criteria ? "normal" : "italic",
              }}
            >
              {goal.success_criteria || "Click to add success criteria"}
            </div>
          )}
        </Section>

        {/* Details */}
        <Section title="Details">
          <div style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "12px" }}>
            <DetailRow label="Time Horizon" value={goal.time_horizon.replace("_", " ")} />
            <DetailRow label="Deadline" value={goal.deadline ? new Date(goal.deadline).toLocaleDateString() : "None"} />
            <DetailRow label="Started" value={goal.started_at ? new Date(goal.started_at).toLocaleDateString() : "Not started"} />
            <DetailRow label="Est. Hours" value={goal.estimated_hours?.toString() ?? "—"} />
            <DetailRow label="Actual Hours" value={goal.actual_hours.toFixed(1)} />
            <DetailRow label="Authority Level" value={goal.authority_level.toString()} />
            {goal.tags.length > 0 && (
              <div style={{ display: "flex", alignItems: "center", gap: "4px", flexWrap: "wrap" }}>
                <span style={{ color: "var(--j-text-muted)", minWidth: "90px" }}>Tags</span>
                {goal.tags.map(t => (
                  <span key={t} style={{
                    fontSize: "10px",
                    padding: "1px 6px",
                    borderRadius: "3px",
                    background: "var(--j-surface)",
                    border: "1px solid var(--j-border)",
                    color: "var(--j-text-dim)",
                  }}>{t}</span>
                ))}
              </div>
            )}
          </div>
        </Section>

        {/* Children */}
        {children.length > 0 && (
          <Section title={`Children (${children.length})`}>
            <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
              {children.map(child => (
                <div key={child.id} style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                  padding: "6px 8px",
                  borderRadius: "4px",
                  background: "var(--j-surface)",
                  border: "1px solid var(--j-border)",
                  fontSize: "12px",
                }}>
                  <span style={{ color: "var(--j-text-muted)", fontSize: "10px" }}>
                    {levelIcons[child.level] ?? ""}
                  </span>
                  <span style={{
                    flex: 1,
                    color: "var(--j-text)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}>
                    {child.title}
                  </span>
                  <span style={{
                    fontSize: "11px",
                    fontWeight: 600,
                    color: scoreColor(child.score),
                  }}>
                    {child.score.toFixed(1)}
                  </span>
                  <span style={{
                    width: "6px",
                    height: "6px",
                    borderRadius: "50%",
                    background: healthColors[child.health] ?? "var(--j-border)",
                  }} />
                </div>
              ))}
            </div>
          </Section>
        )}

        {/* Progress History */}
        {progress.length > 0 && (
          <Section title="Progress History">
            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              {progress.map(entry => (
                <div key={entry.id} style={{
                  padding: "6px 8px",
                  borderRadius: "4px",
                  background: "var(--j-surface)",
                  border: "1px solid var(--j-border)",
                  fontSize: "11px",
                }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "2px" }}>
                    <span style={{ color: "var(--j-text-dim)", fontWeight: 500 }}>
                      {entry.score_before.toFixed(2)} → {entry.score_after.toFixed(2)}
                    </span>
                    <span style={{ color: "var(--j-text-muted)", fontSize: "10px" }}>
                      {new Date(entry.created_at).toLocaleDateString()}
                    </span>
                  </div>
                  {entry.note && (
                    <div style={{ color: "var(--j-text-muted)", fontSize: "10px" }}>
                      {entry.note}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </Section>
        )}

        {/* Danger Zone */}
        <div style={{ marginTop: "8px", paddingTop: "12px", borderTop: "1px solid var(--j-border)" }}>
          {!confirmDelete ? (
            <button
              onClick={() => setConfirmDelete(true)}
              style={{
                width: "100%",
                padding: "8px",
                borderRadius: "6px",
                border: "1px solid var(--j-error)",
                background: "rgba(239, 68, 68, 0.1)",
                color: "var(--j-error)",
                fontSize: "12px",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Delete Goal
            </button>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              <span style={{ fontSize: "12px", color: "var(--j-error)", fontWeight: 500, textAlign: "center" }}>
                Are you sure? This will also delete all child goals.
              </span>
              <div style={{ display: "flex", gap: "8px" }}>
                <button
                  onClick={() => setConfirmDelete(false)}
                  style={{ ...btnSecondary, flex: 1 }}
                >
                  Cancel
                </button>
                <button
                  onClick={handleDelete}
                  style={{
                    flex: 1,
                    padding: "6px 12px",
                    borderRadius: "4px",
                    border: "none",
                    background: "var(--j-error)",
                    color: "#fff",
                    fontSize: "11px",
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  Yes, Delete
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 style={{
        fontSize: "11px",
        fontWeight: 600,
        color: "var(--j-text-muted)",
        textTransform: "uppercase",
        letterSpacing: "0.5px",
        margin: "0 0 6px 0",
      }}>
        {title}
      </h4>
      {children}
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between" }}>
      <span style={{ color: "var(--j-text-muted)" }}>{label}</span>
      <span style={{ color: "var(--j-text)", fontWeight: 500 }}>{value}</span>
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  fontSize: "10px",
  fontWeight: 600,
  color: "var(--j-text-muted)",
  textTransform: "uppercase",
  letterSpacing: "0.5px",
  display: "block",
  marginBottom: "4px",
};

const inputStyle: React.CSSProperties = {
  padding: "6px 8px",
  background: "var(--j-surface)",
  border: "1px solid var(--j-border)",
  borderRadius: "4px",
  color: "var(--j-text)",
  fontSize: "12px",
  outline: "none",
  fontFamily: "inherit",
  width: "100%",
  boxSizing: "border-box",
};

const btnPrimary: React.CSSProperties = {
  padding: "4px 12px",
  borderRadius: "4px",
  border: "none",
  background: "var(--j-accent)",
  color: "#000",
  fontSize: "11px",
  fontWeight: 600,
  cursor: "pointer",
};

const btnSecondary: React.CSSProperties = {
  padding: "4px 12px",
  borderRadius: "4px",
  border: "1px solid var(--j-border)",
  background: "transparent",
  color: "var(--j-text-dim)",
  fontSize: "11px",
  cursor: "pointer",
};

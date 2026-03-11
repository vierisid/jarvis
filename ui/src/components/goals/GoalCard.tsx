import { useState } from "react";
import { api } from "../../hooks/useApi";
import type { Goal } from "../../pages/GoalsPage";

type Props = {
  goal: Goal;
  onClick: (goal: Goal) => void;
  onDelete?: (goalId: string) => void;
};

const healthColors: Record<string, string> = {
  on_track: "var(--j-success)",
  at_risk: "var(--j-warning)",
  behind: "#f97316",
  critical: "var(--j-error)",
};

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

export function GoalCard({ goal, onClick, onDelete }: Props) {
  const [hovered, setHovered] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const daysLeft = goal.deadline
    ? Math.ceil((goal.deadline - Date.now()) / 86400000)
    : null;

  const handleDeleteClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDelete(true);
  };

  const handleConfirmDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await api(`/api/goals/${goal.id}`, { method: "DELETE" });
      onDelete?.(goal.id);
    } catch { /* ignore */ }
    setConfirmDelete(false);
  };

  const handleCancelDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDelete(false);
  };

  return (
    <div
      onClick={() => onClick(goal)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); setConfirmDelete(false); }}
      style={{
        padding: "12px",
        background: "var(--j-surface)",
        border: `1px solid ${hovered ? "var(--j-accent-dim)" : "var(--j-border)"}`,
        borderRadius: "8px",
        cursor: "pointer",
        transition: "border-color 0.15s",
        borderLeft: `3px solid ${healthColors[goal.health] ?? "var(--j-border)"}`,
        position: "relative",
      }}
    >
      {/* Delete button (on hover) */}
      {hovered && !confirmDelete && (
        <button
          onClick={handleDeleteClick}
          title="Delete goal"
          style={{
            position: "absolute",
            top: "6px",
            right: "6px",
            width: "22px",
            height: "22px",
            borderRadius: "4px",
            border: "none",
            background: "rgba(239, 68, 68, 0.15)",
            color: "var(--j-error)",
            fontSize: "12px",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 0,
          }}
        >
          {"\u2715"}
        </button>
      )}

      {/* Confirm delete overlay */}
      {confirmDelete && (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            position: "absolute",
            inset: 0,
            background: "var(--j-surface)",
            borderRadius: "8px",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: "8px",
            zIndex: 1,
          }}
        >
          <span style={{ fontSize: "12px", color: "var(--j-error)", fontWeight: 500 }}>
            Delete this goal?
          </span>
          <div style={{ display: "flex", gap: "8px" }}>
            <button
              onClick={handleCancelDelete}
              style={{
                padding: "4px 12px",
                borderRadius: "4px",
                border: "1px solid var(--j-border)",
                background: "transparent",
                color: "var(--j-text-dim)",
                fontSize: "11px",
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
            <button
              onClick={handleConfirmDelete}
              style={{
                padding: "4px 12px",
                borderRadius: "4px",
                border: "none",
                background: "var(--j-error)",
                color: "#fff",
                fontSize: "11px",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Delete
            </button>
          </div>
        </div>
      )}

      {/* Title row */}
      <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "6px" }}>
        <span style={{ fontSize: "12px", color: "var(--j-text-muted)" }}>
          {levelIcons[goal.level] ?? ""}
        </span>
        <span style={{ fontSize: "13px", fontWeight: 500, color: "var(--j-text)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {goal.title}
        </span>
      </div>

      {/* Score bar */}
      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px" }}>
        <div style={{
          flex: 1,
          height: "4px",
          background: "var(--j-border)",
          borderRadius: "2px",
          overflow: "hidden",
        }}>
          <div style={{
            width: `${goal.score * 100}%`,
            height: "100%",
            background: scoreColor(goal.score),
            borderRadius: "2px",
            transition: "width 0.3s",
          }} />
        </div>
        <span style={{ fontSize: "11px", fontWeight: 600, color: scoreColor(goal.score), minWidth: "28px", textAlign: "right" }}>
          {goal.score.toFixed(1)}
        </span>
      </div>

      {/* Meta row */}
      <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "11px", color: "var(--j-text-muted)" }}>
        <span style={{ textTransform: "capitalize" }}>{goal.level.replace("_", " ")}</span>
        {daysLeft !== null && (
          <span style={{ color: daysLeft < 0 ? "var(--j-error)" : daysLeft < 7 ? "var(--j-warning)" : "var(--j-text-muted)" }}>
            {daysLeft < 0 ? `${Math.abs(daysLeft)}d overdue` : `${daysLeft}d left`}
          </span>
        )}
        {goal.escalation_stage !== "none" && (
          <span style={{ color: "var(--j-error)", fontWeight: 600 }}>
            {goal.escalation_stage.replace("_", " ").toUpperCase()}
          </span>
        )}
        {goal.tags.length > 0 && (
          <span>{goal.tags.slice(0, 2).join(", ")}</span>
        )}
      </div>
    </div>
  );
}

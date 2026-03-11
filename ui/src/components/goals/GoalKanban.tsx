import type { Goal } from "../../pages/GoalsPage";
import { GoalCard } from "./GoalCard";

type Props = {
  goals: Goal[];
  onSelect: (goal: Goal) => void;
  onRefresh: () => void;
};

type Column = {
  id: string;
  label: string;
  filter: (g: Goal) => boolean;
  color: string;
};

const columns: Column[] = [
  { id: "draft", label: "Draft", filter: (g) => g.status === "draft", color: "var(--j-text-muted)" },
  { id: "active", label: "Active", filter: (g) => g.status === "active" && (g.health === "on_track" || g.health === "at_risk"), color: "var(--j-accent)" },
  { id: "at_risk", label: "At Risk / Behind", filter: (g) => g.status === "active" && (g.health === "behind" || g.health === "critical"), color: "var(--j-warning)" },
  { id: "paused", label: "Paused", filter: (g) => g.status === "paused", color: "var(--j-text-dim)" },
  { id: "completed", label: "Done", filter: (g) => g.status === "completed" || g.status === "failed" || g.status === "killed", color: "var(--j-success)" },
];

export function GoalKanban({ goals, onSelect, onRefresh }: Props) {
  // Only show root goals and first-level children in kanban
  const rootGoals = goals.filter(g => !g.parent_id);
  const topGoals = goals.filter(g => !g.parent_id || rootGoals.some(r => r.id === g.parent_id));

  return (
    <div style={{
      display: "flex",
      gap: "12px",
      padding: "16px 24px",
      height: "100%",
      overflowX: "auto",
    }}>
      {columns.map((col) => {
        const colGoals = topGoals.filter(col.filter).sort((a, b) => a.sort_order - b.sort_order);

        return (
          <div key={col.id} style={{
            minWidth: "240px",
            maxWidth: "300px",
            flex: "0 0 260px",
            display: "flex",
            flexDirection: "column",
          }}>
            {/* Column header */}
            <div style={{
              padding: "8px 12px",
              marginBottom: "8px",
              display: "flex",
              alignItems: "center",
              gap: "8px",
            }}>
              <span style={{
                width: "8px",
                height: "8px",
                borderRadius: "50%",
                background: col.color,
                display: "inline-block",
              }} />
              <span style={{ fontSize: "13px", fontWeight: 600, color: "var(--j-text)" }}>
                {col.label}
              </span>
              <span style={{
                fontSize: "11px",
                color: "var(--j-text-muted)",
                background: "var(--j-surface)",
                padding: "1px 6px",
                borderRadius: "10px",
                border: "1px solid var(--j-border)",
              }}>
                {colGoals.length}
              </span>
            </div>

            {/* Cards */}
            <div style={{
              flex: 1,
              overflow: "auto",
              display: "flex",
              flexDirection: "column",
              gap: "8px",
            }}>
              {colGoals.map((goal) => (
                <GoalCard key={goal.id} goal={goal} onClick={onSelect} onDelete={() => onRefresh()} />
              ))}
              {colGoals.length === 0 && (
                <div style={{
                  padding: "20px",
                  textAlign: "center",
                  color: "var(--j-text-muted)",
                  fontSize: "12px",
                  border: "1px dashed var(--j-border)",
                  borderRadius: "8px",
                }}>
                  No goals
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

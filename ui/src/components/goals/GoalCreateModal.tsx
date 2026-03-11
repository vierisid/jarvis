import React, { useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../../hooks/useApi";

type Props = {
  onClose: () => void;
  onCreated: () => void;
};

type GoalProposal = {
  objective: { title: string; description: string; success_criteria: string; time_horizon: string };
  key_results: { title: string; description: string; success_criteria: string }[];
  milestones: { title: string; description: string; key_result_index: number }[];
  clarifying_questions: string[];
};

const levelOptions = [
  { value: "objective", label: "Objective" },
  { value: "key_result", label: "Key Result" },
  { value: "milestone", label: "Milestone" },
  { value: "task", label: "Task" },
  { value: "daily_action", label: "Daily Action" },
];

const timeHorizonOptions = ["life", "yearly", "quarterly", "monthly", "weekly", "daily"];

export function GoalCreateModal({ onClose, onCreated }: Props) {
  const [mode, setMode] = useState<"nl" | "quick">("nl");
  const [nlText, setNlText] = useState("");
  const [proposal, setProposal] = useState<GoalProposal | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // Quick create fields
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [level, setLevel] = useState("task");
  const [timeHorizon, setTimeHorizon] = useState("monthly");
  const [deadline, setDeadline] = useState("");
  const [successCriteria, setSuccessCriteria] = useState("");

  const handleNlSubmit = async () => {
    if (!nlText.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const result = await api<GoalProposal>("/api/goals", {
        method: "POST",
        body: JSON.stringify({ text: nlText.trim(), mode: "propose" }),
      });
      setProposal(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate proposal");
    }
    setLoading(false);
  };

  const handleConfirmProposal = async () => {
    if (!proposal) return;
    setCreating(true);
    setError(null);
    try {
      await api("/api/goals", {
        method: "POST",
        body: JSON.stringify({ proposal, mode: "create_from_proposal" }),
      });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create goals");
    }
    setCreating(false);
  };

  const handleQuickCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    setCreating(true);
    setError(null);
    try {
      await api("/api/goals", {
        method: "POST",
        body: JSON.stringify({
          mode: "quick",
          title: title.trim(),
          description: description.trim(),
          level,
          time_horizon: timeHorizon,
          success_criteria: successCriteria.trim(),
          deadline: deadline ? new Date(deadline).getTime() : undefined,
        }),
      });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create goal");
    }
    setCreating(false);
  };

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  return createPortal(
    <div
      onClick={handleBackdropClick}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0, 0, 0, 0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
    >
      <div style={{
        width: "560px",
        maxWidth: "90vw",
        maxHeight: "80vh",
        background: "var(--j-surface)",
        border: "1px solid var(--j-border)",
        borderRadius: "12px",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}>
        {/* Header */}
        <div style={{
          padding: "20px 24px 16px",
          borderBottom: "1px solid var(--j-border)",
          flexShrink: 0,
        }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "12px" }}>
            <h2 style={{ fontSize: "16px", fontWeight: 600, color: "var(--j-text)", margin: 0 }}>
              New Goal
            </h2>
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

          {/* Mode toggle */}
          <div style={{ display: "flex", gap: "4px" }}>
            <ModeBtn label="Natural Language" active={mode === "nl"} onClick={() => { setMode("nl"); setProposal(null); setError(null); }} />
            <ModeBtn label="Quick Create" active={mode === "quick"} onClick={() => { setMode("quick"); setProposal(null); setError(null); }} />
          </div>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflow: "auto", padding: "20px 24px" }}>
          {mode === "nl" && !proposal && (
            <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              <p style={{ fontSize: "12px", color: "var(--j-text-muted)", margin: 0 }}>
                Describe your goal in natural language. JARVIS will propose an OKR breakdown with objectives, key results, and milestones.
              </p>
              <textarea
                placeholder="e.g., I want to get in the best shape of my life by summer. I want to lose 15 pounds, run a half marathon, and build a consistent gym habit."
                value={nlText}
                onChange={(e) => setNlText(e.target.value)}
                rows={5}
                autoFocus
                style={inputStyle}
              />
            </div>
          )}

          {mode === "nl" && proposal && (
            <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
              <p style={{ fontSize: "12px", color: "var(--j-text-muted)", margin: 0 }}>
                Review the proposed OKR breakdown below. Click confirm to create all goals.
              </p>

              {/* Objective */}
              <ProposalCard
                icon={"\u25C6"}
                level="Objective"
                title={proposal.objective.title}
                description={proposal.objective.description}
                criteria={proposal.objective.success_criteria}
              />

              {/* Key Results */}
              {proposal.key_results.map((kr, i) => (
                <div key={i}>
                  <ProposalCard
                    icon={"\u25B8"}
                    level={`Key Result ${i + 1}`}
                    title={kr.title}
                    description={kr.description}
                    criteria={kr.success_criteria}
                    indent
                  />
                  {/* Milestones under this KR */}
                  {proposal.milestones
                    .filter(m => m.key_result_index === i)
                    .map((m, j) => (
                      <ProposalCard
                        key={j}
                        icon={"\u25A0"}
                        level="Milestone"
                        title={m.title}
                        description={m.description}
                        indent
                        deepIndent
                      />
                    ))}
                </div>
              ))}

              {/* Clarifying questions */}
              {proposal.clarifying_questions.length > 0 && (
                <div style={{
                  padding: "12px",
                  background: "rgba(0, 212, 255, 0.05)",
                  border: "1px solid rgba(0, 212, 255, 0.2)",
                  borderRadius: "6px",
                }}>
                  <div style={{ fontSize: "11px", fontWeight: 600, color: "var(--j-accent)", marginBottom: "6px" }}>
                    Clarifying Questions
                  </div>
                  {proposal.clarifying_questions.map((q, i) => (
                    <div key={i} style={{ fontSize: "12px", color: "var(--j-text-dim)", marginBottom: "4px" }}>
                      {i + 1}. {q}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {mode === "quick" && (
            <form id="quick-create-form" onSubmit={handleQuickCreate} style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                <label style={labelStyle}>Title</label>
                <input
                  type="text"
                  placeholder="What do you want to achieve?"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  autoFocus
                  style={inputStyle}
                />
              </div>

              <div style={{ display: "flex", gap: "12px" }}>
                <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "4px" }}>
                  <label style={labelStyle}>Level</label>
                  <select value={level} onChange={(e) => setLevel(e.target.value)} style={inputStyle}>
                    {levelOptions.map(l => (
                      <option key={l.value} value={l.value}>{l.label}</option>
                    ))}
                  </select>
                </div>
                <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "4px" }}>
                  <label style={labelStyle}>Time Horizon</label>
                  <select value={timeHorizon} onChange={(e) => setTimeHorizon(e.target.value)} style={inputStyle}>
                    {timeHorizonOptions.map(t => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                <label style={labelStyle}>Description</label>
                <textarea
                  placeholder="Describe this goal..."
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={3}
                  style={inputStyle}
                />
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                <label style={labelStyle}>Success Criteria</label>
                <input
                  type="text"
                  placeholder="How will you know it's done?"
                  value={successCriteria}
                  onChange={(e) => setSuccessCriteria(e.target.value)}
                  style={inputStyle}
                />
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                <label style={labelStyle}>Deadline (optional)</label>
                <input
                  type="datetime-local"
                  value={deadline}
                  onChange={(e) => setDeadline(e.target.value)}
                  style={inputStyle}
                />
              </div>
            </form>
          )}

          {loading && (
            <div style={{ textAlign: "center", padding: "20px", color: "var(--j-text-muted)", fontSize: "13px" }}>
              Generating OKR breakdown...
            </div>
          )}

          {error && (
            <div style={{ color: "var(--j-error)", fontSize: "12px", marginTop: "8px" }}>
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{
          padding: "16px 24px",
          borderTop: "1px solid var(--j-border)",
          display: "flex",
          gap: "8px",
          justifyContent: "flex-end",
          flexShrink: 0,
        }}>
          <button
            onClick={onClose}
            style={{
              padding: "8px 16px",
              borderRadius: "6px",
              border: "1px solid var(--j-border)",
              background: "transparent",
              color: "var(--j-text-dim)",
              cursor: "pointer",
              fontSize: "13px",
            }}
          >
            Cancel
          </button>

          {mode === "nl" && !proposal && (
            <button
              onClick={handleNlSubmit}
              disabled={!nlText.trim() || loading}
              style={{
                padding: "8px 20px",
                borderRadius: "6px",
                border: "none",
                background: nlText.trim() && !loading ? "var(--j-accent)" : "var(--j-border)",
                color: nlText.trim() && !loading ? "#000" : "var(--j-text-muted)",
                cursor: nlText.trim() && !loading ? "pointer" : "not-allowed",
                fontSize: "13px",
                fontWeight: 600,
              }}
            >
              {loading ? "Generating..." : "Generate OKR"}
            </button>
          )}

          {mode === "nl" && proposal && (
            <>
              <button
                onClick={() => setProposal(null)}
                style={{
                  padding: "8px 16px",
                  borderRadius: "6px",
                  border: "1px solid var(--j-border)",
                  background: "transparent",
                  color: "var(--j-text-dim)",
                  cursor: "pointer",
                  fontSize: "13px",
                }}
              >
                Edit Input
              </button>
              <button
                onClick={handleConfirmProposal}
                disabled={creating}
                style={{
                  padding: "8px 20px",
                  borderRadius: "6px",
                  border: "none",
                  background: creating ? "var(--j-border)" : "var(--j-accent)",
                  color: creating ? "var(--j-text-muted)" : "#000",
                  cursor: creating ? "not-allowed" : "pointer",
                  fontSize: "13px",
                  fontWeight: 600,
                }}
              >
                {creating ? "Creating..." : "Confirm & Create"}
              </button>
            </>
          )}

          {mode === "quick" && (
            <button
              type="submit"
              form="quick-create-form"
              disabled={!title.trim() || creating}
              style={{
                padding: "8px 20px",
                borderRadius: "6px",
                border: "none",
                background: title.trim() && !creating ? "var(--j-accent)" : "var(--j-border)",
                color: title.trim() && !creating ? "#000" : "var(--j-text-muted)",
                cursor: title.trim() && !creating ? "pointer" : "not-allowed",
                fontSize: "13px",
                fontWeight: 600,
              }}
            >
              {creating ? "Creating..." : "Create Goal"}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

function ModeBtn({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "5px 12px",
        borderRadius: "5px",
        border: "1px solid " + (active ? "var(--j-accent)" : "var(--j-border)"),
        background: active ? "rgba(0, 212, 255, 0.1)" : "transparent",
        color: active ? "var(--j-accent)" : "var(--j-text-dim)",
        fontSize: "12px",
        fontWeight: active ? 600 : 400,
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}

function ProposalCard({ icon, level, title, description, criteria, indent, deepIndent }: {
  icon: string;
  level: string;
  title: string;
  description: string;
  criteria?: string;
  indent?: boolean;
  deepIndent?: boolean;
}) {
  return (
    <div style={{
      padding: "10px 12px",
      background: "var(--j-bg)",
      border: "1px solid var(--j-border)",
      borderRadius: "6px",
      marginLeft: deepIndent ? "32px" : indent ? "16px" : "0",
      marginTop: deepIndent ? "4px" : "0",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "4px" }}>
        <span style={{ fontSize: "12px", color: "var(--j-text-muted)" }}>{icon}</span>
        <span style={{ fontSize: "10px", fontWeight: 600, color: "var(--j-accent)", textTransform: "uppercase" }}>{level}</span>
      </div>
      <div style={{ fontSize: "13px", fontWeight: 500, color: "var(--j-text)", marginBottom: "2px" }}>
        {title}
      </div>
      <div style={{ fontSize: "11px", color: "var(--j-text-muted)" }}>
        {description}
      </div>
      {criteria && (
        <div style={{ fontSize: "11px", color: "var(--j-text-dim)", marginTop: "4px", fontStyle: "italic" }}>
          Criteria: {criteria}
        </div>
      )}
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  fontSize: "11px",
  fontWeight: 600,
  color: "var(--j-text-muted)",
  textTransform: "uppercase",
  letterSpacing: "0.5px",
};

const inputStyle: React.CSSProperties = {
  padding: "8px 10px",
  background: "var(--j-bg)",
  border: "1px solid var(--j-border)",
  borderRadius: "6px",
  color: "var(--j-text)",
  fontSize: "13px",
  outline: "none",
  fontFamily: "inherit",
  resize: "none",
  width: "100%",
  boxSizing: "border-box",
};

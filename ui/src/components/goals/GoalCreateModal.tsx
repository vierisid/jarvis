import React, { useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../../hooks/useApi";

type Props = {
  onClose: () => void;
  onCreated: () => void;
  initialText?: string;
};

type GoalProposal = {
  objective: { title: string; description: string; success_criteria: string; time_horizon: string };
  key_results: { title: string; description: string; success_criteria: string }[];
  milestones: { title: string; description: string; key_result_index: number }[];
  clarifying_questions: string[];
};

const levelOptions = [
  { value: "objective",    label: "Objective" },
  { value: "key_result",  label: "Key Result" },
  { value: "milestone",   label: "Milestone" },
  { value: "task",        label: "Task" },
  { value: "daily_action", label: "Daily Action" },
];

const timeHorizonOptions = ["life", "yearly", "quarterly", "monthly", "weekly", "daily"];

export function GoalCreateModal({ onClose, onCreated, initialText = "" }: Props) {
  const [mode, setMode]         = useState<"nl" | "quick">(initialText ? "nl" : "quick");
  const [nlText, setNlText]     = useState(initialText);
  const [proposal, setProposal] = useState<GoalProposal | null>(null);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // Quick create fields
  const [title, setTitle]                   = useState("");
  const [description, setDescription]       = useState("");
  const [level, setLevel]                   = useState("task");
  const [timeHorizon, setTimeHorizon]       = useState("monthly");
  const [deadline, setDeadline]             = useState("");
  const [successCriteria, setSuccessCriteria] = useState("");

  // ----------------------------------------------------------------
  // Handlers
  // ----------------------------------------------------------------

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

  const switchMode = (m: "nl" | "quick") => {
    setMode(m);
    setProposal(null);
    setError(null);
  };

  // ----------------------------------------------------------------
  // Render
  // ----------------------------------------------------------------

  return createPortal(
    <div className="goals-modal-backdrop" onClick={handleBackdropClick} role="dialog" aria-modal="true" aria-label="Create new goal">
      <div className="goals-modal">

        {/* Header */}
        <div className="goals-modal-header">
          <div className="goals-modal-title">New Goal</div>
          <button
            className="goals-modal-close"
            onClick={onClose}
            aria-label="Close modal"
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
              <line x1="1" y1="1" x2="9" y2="9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              <line x1="9" y1="1" x2="1" y2="9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </button>
        </div>

        {/* Mode toggle */}
        <div className="goals-mode-toggle" role="tablist" aria-label="Create mode">
          <button
            className={`goals-mode-btn${mode === "nl" ? " active" : ""}`}
            onClick={() => switchMode("nl")}
            role="tab"
            aria-selected={mode === "nl"}
          >
            {/* Natural-language doc icon */}
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <circle cx="6" cy="6" r="5" stroke="currentColor" strokeWidth="1.2"/>
              <path d="M4 6h4M4 4h3M4 8h2" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/>
            </svg>
            Natural Language
          </button>
          <button
            className={`goals-mode-btn${mode === "quick" ? " active" : ""}`}
            onClick={() => switchMode("quick")}
            role="tab"
            aria-selected={mode === "quick"}
          >
            {/* Form / quick-create icon */}
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <rect x="1" y="1" width="10" height="10" rx="2" stroke="currentColor" strokeWidth="1.2"/>
              <line x1="3" y1="4" x2="9" y2="4" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
              <line x1="3" y1="6" x2="7" y2="6" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
            </svg>
            Quick Create
          </button>
        </div>

        {/* Body */}
        <div className="goals-modal-body">

          {/* NL mode — no proposal yet */}
          {mode === "nl" && !proposal && !loading && (
            <>
              <p className="goals-modal-desc">
                Describe your goal in plain language. JARVIS will generate a structured OKR hierarchy
                — Objective, Key Results, and Milestones — for your review.
              </p>
              <textarea
                className="goals-ai-textarea"
                placeholder="e.g. I want to launch my SaaS product by April with full API coverage, a polished dashboard, and 80% test coverage. I've already built the auth module."
                value={nlText}
                onChange={e => setNlText(e.target.value)}
                autoFocus
                aria-label="Describe your goal"
              />
            </>
          )}

          {/* NL mode — loading */}
          {mode === "nl" && loading && (
            <div className="goals-modal-loading">Generating OKR breakdown...</div>
          )}

          {/* NL mode — proposal review */}
          {mode === "nl" && proposal && !loading && (
            <>
              <p className="goals-modal-desc">
                Review the proposed OKR breakdown below. Click confirm to create all goals.
              </p>

              <div className="goals-proposal-divider">
                <span className="goals-proposal-divider-label">PROPOSED STRUCTURE</span>
              </div>

              {/* Objective */}
              <div className="goals-proposal-item level-objective">
                <div className="goals-proposal-icon level-objective">
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                    <path d="M6 1L7.5 4.5L11 5L8.5 7.5L9 11L6 9.5L3 11L3.5 7.5L1 5L4.5 4.5L6 1Z" fill="var(--violet-bright)"/>
                  </svg>
                </div>
                <div className="goals-proposal-content">
                  <div className="goals-proposal-type level-objective">OBJECTIVE</div>
                  <div className="goals-proposal-name">{proposal.objective.title}</div>
                  <div className="goals-proposal-desc">{proposal.objective.description}</div>
                </div>
              </div>

              {/* Key Results + their Milestones */}
              {proposal.key_results.map((kr, i) => (
                <React.Fragment key={i}>
                  <div className="goals-proposal-item level-key_result indent-1">
                    <div className="goals-proposal-icon level-key_result">
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                        <path d="M2 6L5 9L10 3" stroke="var(--blue)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    </div>
                    <div className="goals-proposal-content">
                      <div className="goals-proposal-type level-key_result">KEY RESULT {i + 1}</div>
                      <div className="goals-proposal-name">{kr.title}</div>
                      <div className="goals-proposal-desc">{kr.description}</div>
                    </div>
                  </div>

                  {proposal.milestones
                    .filter(m => m.key_result_index === i)
                    .map((m, j) => (
                      <div key={j} className="goals-proposal-item level-milestone indent-2">
                        <div className="goals-proposal-icon level-milestone">
                          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                            <rect x="1" y="1" width="8" height="8" rx="2" stroke="var(--emerald)" strokeWidth="1.4"/>
                          </svg>
                        </div>
                        <div className="goals-proposal-content">
                          <div className="goals-proposal-type level-milestone">MILESTONE</div>
                          <div className="goals-proposal-name">{m.title}</div>
                          <div className="goals-proposal-desc">{m.description}</div>
                        </div>
                      </div>
                    ))}
                </React.Fragment>
              ))}

              {/* Clarifying questions */}
              {proposal.clarifying_questions.length > 0 && (
                <div className="goals-clarify-box" aria-label="Clarifying questions">
                  <div className="goals-clarify-label">CLARIFYING QUESTIONS</div>
                  {proposal.clarifying_questions.map((q, i) => (
                    <div key={i} className="goals-clarify-question">
                      <span className="goals-clarify-number">{i + 1}.</span>
                      <span>{q}</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {/* Quick Create form */}
          {mode === "quick" && (
            <form
              id="quick-create-form"
              className="goals-quick-form"
              onSubmit={handleQuickCreate}
              aria-label="Quick create goal form"
            >
              <div className="goals-form-field">
                <label className="goals-form-label" htmlFor="qc-title">TITLE</label>
                <input
                  id="qc-title"
                  type="text"
                  className="goals-form-input"
                  placeholder="What do you want to achieve?"
                  value={title}
                  onChange={e => setTitle(e.target.value)}
                  autoFocus
                  required
                />
              </div>

              <div className="goals-form-row">
                <div className="goals-form-field">
                  <label className="goals-form-label" htmlFor="qc-level">LEVEL</label>
                  <select
                    id="qc-level"
                    className="goals-form-select"
                    value={level}
                    onChange={e => setLevel(e.target.value)}
                  >
                    {levelOptions.map(l => (
                      <option key={l.value} value={l.value}>{l.label}</option>
                    ))}
                  </select>
                </div>
                <div className="goals-form-field">
                  <label className="goals-form-label" htmlFor="qc-horizon">TIME HORIZON</label>
                  <select
                    id="qc-horizon"
                    className="goals-form-select"
                    value={timeHorizon}
                    onChange={e => setTimeHorizon(e.target.value)}
                  >
                    {timeHorizonOptions.map(t => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="goals-form-field">
                <label className="goals-form-label" htmlFor="qc-desc">DESCRIPTION</label>
                <textarea
                  id="qc-desc"
                  className="goals-form-textarea"
                  placeholder="Describe this goal..."
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  rows={3}
                />
              </div>

              <div className="goals-form-field">
                <label className="goals-form-label" htmlFor="qc-criteria">SUCCESS CRITERIA</label>
                <input
                  id="qc-criteria"
                  type="text"
                  className="goals-form-input"
                  placeholder="How will you know it's done?"
                  value={successCriteria}
                  onChange={e => setSuccessCriteria(e.target.value)}
                />
              </div>

              <div className="goals-form-field">
                <label className="goals-form-label" htmlFor="qc-deadline">DEADLINE (OPTIONAL)</label>
                <input
                  id="qc-deadline"
                  type="datetime-local"
                  className="goals-form-input"
                  value={deadline}
                  onChange={e => setDeadline(e.target.value)}
                />
              </div>
            </form>
          )}

          {/* Error display */}
          {error && <div className="goals-modal-error" role="alert">{error}</div>}
        </div>

        {/* Footer */}
        <div className="goals-modal-footer">
          <button className="goals-modal-cancel" onClick={onClose}>
            Cancel
          </button>

          {/* NL — no proposal: Generate button */}
          {mode === "nl" && !proposal && (
            <button
              className="goals-modal-confirm"
              onClick={handleNlSubmit}
              disabled={!nlText.trim() || loading}
              aria-label="Generate OKR structure"
            >
              <svg width="11" height="11" viewBox="0 0 13 13" fill="none" aria-hidden="true">
                <path d="M6.5 1L8 5H12L8.5 7.5L10 11.5L6.5 9L3 11.5L4.5 7.5L1 5H5L6.5 1Z" fill="currentColor" opacity="0.9"/>
              </svg>
              {loading ? "Generating..." : "Generate OKR Structure"}
            </button>
          )}

          {/* NL — proposal shown: Edit + Confirm */}
          {mode === "nl" && proposal && (
            <>
              <button
                className="goals-modal-edit"
                onClick={() => setProposal(null)}
              >
                Edit Input
              </button>
              <button
                className="goals-modal-confirm"
                onClick={handleConfirmProposal}
                disabled={creating}
                aria-label="Confirm and create goals from proposal"
              >
                <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true">
                  <path d="M2 5.5L4.5 8L9 3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                {creating ? "Creating..." : "Confirm & Create"}
              </button>
            </>
          )}

          {/* Quick Create: submit button */}
          {mode === "quick" && (
            <button
              type="submit"
              form="quick-create-form"
              className="goals-modal-confirm"
              disabled={!title.trim() || creating}
              aria-label="Create goal"
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

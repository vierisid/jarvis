import React, { useEffect, useMemo, useState } from "react";
import { api, useApiData } from "../../hooks/useApi";

type UserProfileQuestion = {
  id: string;
  step: number;
  step_title: string;
  label: string;
  prompt: string;
  description: string;
  placeholder?: string;
  multiline?: boolean;
};

type UserProfileRecord = {
  version: 1;
  answers: Record<string, string>;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
};

type UserProfileResponse = {
  questions: UserProfileQuestion[];
  profile: UserProfileRecord | null;
  answered_count: number;
  total_questions: number;
  has_profile: boolean;
};

const cardStyle: React.CSSProperties = {
  padding: "20px",
  background: "var(--j-surface)",
  border: "1px solid var(--j-border)",
  borderRadius: "8px",
};

export function UserProfilePanel() {
  const { data, loading, error, refetch } = useApiData<UserProfileResponse>("/api/user-profile", []);
  const [editing, setEditing] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ text: string; type: "success" | "error" } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!data) return;
    setAnswers(data.profile?.answers ?? {});
  }, [data]);

  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(null), 5000);
    return () => clearTimeout(timer);
  }, [message]);

  const steps = useMemo(() => {
    if (!data) return [];
    const grouped = new Map<number, { title: string; questions: UserProfileQuestion[] }>();
    for (const question of data.questions) {
      const group = grouped.get(question.step) ?? { title: question.step_title, questions: [] };
      group.questions.push(question);
      grouped.set(question.step, group);
    }
    return Array.from(grouped.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([step, group]) => ({ step, title: group.title, questions: group.questions }));
  }, [data]);

  const currentStep = steps[stepIndex];
  const liveAnsweredCount = useMemo(() => {
    if (!data) return 0;
    return data.questions.filter((question) => {
      const value = answers[question.id];
      return typeof value === "string" && value.trim().length > 0;
    }).length;
  }, [answers, data]);
  const answeredCount = editing ? liveAnsweredCount : data?.answered_count ?? 0;
  const completionPct = data ? Math.round((answeredCount / Math.max(data.total_questions, 1)) * 100) : 0;

  const saveProfile = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const resp = await api<{ message: string }>("/api/user-profile", {
        method: "POST",
        body: JSON.stringify({ answers }),
      });
      setMessage({ text: resp.message, type: "success" });
      setEditing(false);
      refetch();
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : "Failed to save user profile", type: "error" });
    } finally {
      setSaving(false);
    }
  };

  const clearProfile = async () => {
    if (!window.confirm("Clear the saved user profile context?")) return;
    try {
      await api<{ message: string }>("/api/user-profile/clear", { method: "POST" });
      setAnswers({});
      setEditing(false);
      setStepIndex(0);
      setMessage({ text: "User profile cleared.", type: "success" });
      refetch();
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : "Failed to clear user profile", type: "error" });
    }
  };

  if (error && !data) {
    return (
      <div style={cardStyle}>
        <span style={{ color: "var(--j-danger, #ff6b6b)", fontSize: "13px" }}>{error}</span>
      </div>
    );
  }

  if (loading || !data) {
    return (
      <div style={cardStyle}>
        <span style={{ color: "var(--j-text-muted)", fontSize: "13px" }}>Loading user profile wizard...</span>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      <div style={cardStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: "16px", alignItems: "flex-start", flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: "280px" }}>
            <h3 style={{ fontSize: "14px", fontWeight: 600, color: "var(--j-text)", margin: 0 }}>Initial User Context</h3>
            <p style={{ fontSize: "13px", color: "var(--j-text-muted)", margin: "8px 0 0 0", lineHeight: 1.6 }}>
              This wizard gives JARVIS durable context about who you are, what matters to you, and how you prefer to work.
              It is meant to be the initial context dump you can refine later.
            </p>
          </div>
          <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
            <button style={primaryButton} onClick={() => { setEditing(true); setStepIndex(0); }}>
              {data.has_profile ? "Edit Profile" : "Start Wizard"}
            </button>
            {data.has_profile && (
              <button style={secondaryButton} onClick={clearProfile}>
                Clear
              </button>
            )}
          </div>
        </div>

        <div style={{ marginTop: "18px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px", marginBottom: "8px" }}>
            <span style={{ color: "var(--j-text-muted)" }}>Completion</span>
            <span style={{ color: "var(--j-text)" }}>{answeredCount}/{data.total_questions} answered</span>
          </div>
          <div style={{ height: "6px", borderRadius: "999px", background: "var(--j-bg)", overflow: "hidden" }}>
            <div style={{ width: `${completionPct}%`, height: "100%", background: "var(--j-accent)" }} />
          </div>
        </div>

        {data.profile?.updated_at && (
          <div style={{ marginTop: "12px", fontSize: "12px", color: "var(--j-text-muted)" }}>
            Last updated: {new Date(data.profile.updated_at).toLocaleString()}
          </div>
        )}
      </div>

      {message && (
        <div style={{
          ...cardStyle,
          borderColor: message.type === "success" ? "rgba(16,185,129,0.35)" : "rgba(239,68,68,0.35)",
          color: message.type === "success" ? "var(--j-success, #10b981)" : "var(--j-danger, #ef4444)",
          fontSize: "13px",
        }}>
          {message.text}
        </div>
      )}

      {editing && currentStep ? (
        <div style={cardStyle}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", marginBottom: "20px", flexWrap: "wrap" }}>
            <div>
              <div style={{ fontSize: "11px", letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--j-text-muted)", marginBottom: "6px" }}>
                Step {stepIndex + 1} of {steps.length}
              </div>
              <h3 style={{ margin: 0, fontSize: "16px", color: "var(--j-text)" }}>{currentStep.title}</h3>
            </div>
            <button style={secondaryButton} onClick={() => setEditing(false)}>Cancel</button>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
            {currentStep.questions.map((question) => (
              <label key={question.id} style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                <div>
                  <div style={{ fontSize: "13px", fontWeight: 600, color: "var(--j-text)" }}>{question.label}</div>
                  <div style={{ fontSize: "12px", color: "var(--j-text-muted)", marginTop: "4px", lineHeight: 1.5 }}>
                    {question.prompt} {question.description}
                  </div>
                </div>

                {question.multiline ? (
                  <textarea
                    value={answers[question.id] ?? ""}
                    onChange={(e) => setAnswers((prev) => ({ ...prev, [question.id]: e.target.value }))}
                    placeholder={question.placeholder}
                    rows={5}
                    style={textareaStyle}
                  />
                ) : (
                  <input
                    value={answers[question.id] ?? ""}
                    onChange={(e) => setAnswers((prev) => ({ ...prev, [question.id]: e.target.value }))}
                    placeholder={question.placeholder}
                    style={inputStyle}
                  />
                )}
              </label>
            ))}
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", marginTop: "24px", flexWrap: "wrap" }}>
            <button
              style={secondaryButton}
              onClick={() => setStepIndex((prev) => Math.max(prev - 1, 0))}
              disabled={stepIndex === 0}
            >
              Previous
            </button>
            <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
              {stepIndex < steps.length - 1 ? (
                <button style={primaryButton} onClick={() => setStepIndex((prev) => Math.min(prev + 1, steps.length - 1))}>
                  Next
                </button>
              ) : (
                <button style={primaryButton} onClick={saveProfile} disabled={saving}>
                  {saving ? "Saving..." : "Save Profile"}
                </button>
              )}
            </div>
          </div>
        </div>
      ) : data.has_profile ? (
        <div style={cardStyle}>
          <h3 style={{ fontSize: "14px", fontWeight: 600, color: "var(--j-text)", marginTop: 0, marginBottom: "18px" }}>Saved Context</h3>
          <div style={{ display: "grid", gap: "14px" }}>
            {steps.map((step) => {
              const answeredQuestions = step.questions.filter((question) => {
                const value = data.profile?.answers[question.id];
                return typeof value === "string" && value.trim().length > 0;
              });
              if (answeredQuestions.length === 0) return null;

              return (
                <div key={step.step} style={{ border: "1px solid var(--j-border)", borderRadius: "8px", padding: "16px" }}>
                  <div style={{ fontSize: "11px", letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--j-text-muted)", marginBottom: "10px" }}>
                    {step.title}
                  </div>
                  <div style={{ display: "grid", gap: "12px" }}>
                    {answeredQuestions.map((question) => (
                      <div key={question.id}>
                        <div style={{ fontSize: "12px", fontWeight: 600, color: "var(--j-text)" }}>{question.label}</div>
                        <div style={{ fontSize: "13px", color: "var(--j-text-muted)", marginTop: "4px", whiteSpace: "pre-wrap", lineHeight: 1.6 }}>
                          {data.profile?.answers[question.id]}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div style={cardStyle}>
          <div style={{ fontSize: "13px", color: "var(--j-text-muted)", lineHeight: 1.6 }}>
            No user profile has been saved yet. Start the wizard to give JARVIS a strong initial understanding of your identity,
            goals, preferences, routines, and context.
          </div>
        </div>
      )}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  borderRadius: "8px",
  border: "1px solid var(--j-border)",
  background: "var(--j-bg)",
  color: "var(--j-text)",
  fontSize: "13px",
  outline: "none",
};

const textareaStyle: React.CSSProperties = {
  ...inputStyle,
  minHeight: "120px",
  resize: "vertical",
  fontFamily: "inherit",
};

const primaryButton: React.CSSProperties = {
  padding: "10px 14px",
  borderRadius: "8px",
  border: "1px solid rgba(0, 212, 255, 0.2)",
  background: "rgba(0, 212, 255, 0.12)",
  color: "var(--j-accent)",
  cursor: "pointer",
  fontSize: "13px",
  fontWeight: 600,
};

const secondaryButton: React.CSSProperties = {
  padding: "10px 14px",
  borderRadius: "8px",
  border: "1px solid var(--j-border)",
  background: "transparent",
  color: "var(--j-text)",
  cursor: "pointer",
  fontSize: "13px",
  fontWeight: 500,
};

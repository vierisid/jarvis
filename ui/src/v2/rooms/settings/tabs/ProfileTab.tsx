import React, { useEffect, useMemo, useState } from "react";
import type { SettingsHook } from "../useSettingsData";
import { resetOnboarding } from "../../../onboarding/resetClient";

export function ProfileTab({
  data,
  onToast,
}: {
  data: SettingsHook;
  onToast: (text: string, tone?: "ok" | "warn") => void;
}) {
  const profile = data.profile;
  const [editing, setEditing] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!profile) return;
    setAnswers(profile.profile?.answers ?? {});
  }, [profile]);

  const steps = useMemo(() => {
    if (!profile) return [];
    const grouped = new Map<number, { title: string; questions: typeof profile.questions }>();
    for (const q of profile.questions) {
      const g = grouped.get(q.step) ?? { title: q.step_title, questions: [] };
      g.questions.push(q);
      grouped.set(q.step, g);
    }
    return [...grouped.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([s, g]) => ({ step: s, title: g.title, questions: g.questions }));
  }, [profile]);

  const currentStep = steps[stepIndex];
  const answeredLive = useMemo(() => {
    if (!profile) return 0;
    return profile.questions.filter((q) => {
      const v = answers[q.id];
      return typeof v === "string" && v.trim().length > 0;
    }).length;
  }, [answers, profile]);
  const total = profile?.total_questions ?? 0;
  const answered = editing ? answeredLive : profile?.answered_count ?? 0;
  const pct = total ? Math.round((answered / total) * 100) : 0;

  const handleSave = async () => {
    setSaving(true);
    const r = await data.saveProfile(answers);
    onToast(r.message, r.ok ? "ok" : "warn");
    if (r.ok) setEditing(false);
    setSaving(false);
  };

  const handleClear = async () => {
    if (!confirm("Clear the saved user profile context?")) return;
    const r = await data.clearProfile();
    if (r.ok) {
      setAnswers({});
      setEditing(false);
      setStepIndex(0);
    }
    onToast(r.message, r.ok ? "ok" : "warn");
  };

  if (!profile) {
    return <div className="v2-set__empty">Loading profile…</div>;
  }

  return (
    <div>
      {/* Header card */}
      <section className="v2-set__section">
        <div className="v2-set__section-head">
          <div>
            <h3 className="v2-set__section-title">Initial User Context</h3>
            <div className="v2-set__section-sub">
              Durable context Jarvis uses for every conversation. Not a one-shot — refine it any time.
            </div>
          </div>
          <div style={{ display: "flex", gap: "var(--s-2)", flexWrap: "wrap" }}>
            <button
              type="button"
              className="v2-set__btn v2-set__btn--primary"
              onClick={() => {
                setEditing(true);
                setStepIndex(0);
              }}
            >
              {profile.has_profile ? "Edit profile" : "Start wizard"}
            </button>
            {profile.has_profile && (
              <button type="button" className="v2-set__btn v2-set__btn--danger" onClick={handleClear}>
                Clear
              </button>
            )}
          </div>
        </div>

        <div className="v2-set__field">
          <div className="v2-set__row">
            <span className="v2-set__row-label">Completion</span>
            <span className="v2-set__row-value">
              {answered}/{total} answered
            </span>
          </div>
          <div className="v2-set__wizard-progress">
            <div className="v2-set__wizard-progress-fill" style={{ width: `${pct}%` }} />
          </div>
        </div>

        {profile.profile?.updated_at && (
          <div className="v2-set__row">
            <span className="v2-set__row-label">Last updated</span>
            <span className="v2-set__row-value">
              {new Date(profile.profile.updated_at).toLocaleString()}
            </span>
          </div>
        )}
      </section>

      {/* Wizard / snapshot */}
      {editing && currentStep ? (
        <section className="v2-set__section">
          <div className="v2-set__section-head">
            <div>
              <div className="v2-set__wizard-step">
                Step {stepIndex + 1} of {steps.length}
              </div>
              <h3 className="v2-set__section-title" style={{ marginTop: 4 }}>
                {currentStep.title}
              </h3>
            </div>
            <button type="button" className="v2-set__btn" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-4)" }}>
            {currentStep.questions.map((q) => (
              <div key={q.id} className="v2-set__field">
                <div>
                  <div style={{ fontSize: "var(--text-sm)", color: "var(--ink)" }}>{q.label}</div>
                  <div className="v2-set__hint">
                    {q.prompt} {q.description}
                  </div>
                </div>
                {q.multiline ? (
                  <textarea
                    className="v2-set__textarea"
                    value={answers[q.id] ?? ""}
                    onChange={(e) => setAnswers((p) => ({ ...p, [q.id]: e.target.value }))}
                    placeholder={q.placeholder}
                  />
                ) : (
                  <input
                    className="v2-set__input"
                    value={answers[q.id] ?? ""}
                    onChange={(e) => setAnswers((p) => ({ ...p, [q.id]: e.target.value }))}
                    placeholder={q.placeholder}
                  />
                )}
              </div>
            ))}
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", gap: "var(--s-2)" }}>
            <button
              type="button"
              className="v2-set__btn"
              disabled={stepIndex === 0}
              onClick={() => setStepIndex((p) => Math.max(p - 1, 0))}
            >
              Previous
            </button>
            {stepIndex < steps.length - 1 ? (
              <button
                type="button"
                className="v2-set__btn v2-set__btn--primary"
                onClick={() => setStepIndex((p) => Math.min(p + 1, steps.length - 1))}
              >
                Next
              </button>
            ) : (
              <button
                type="button"
                className="v2-set__btn v2-set__btn--primary"
                onClick={handleSave}
                disabled={saving}
              >
                {saving ? "Saving…" : "Save profile"}
              </button>
            )}
          </div>
        </section>
      ) : profile.has_profile ? (
        <section className="v2-set__section">
          <h3 className="v2-set__section-title">Saved context</h3>
          <div className="v2-set__profile-snapshot">
            {steps.map((step) => {
              const answered = step.questions.filter((q) => {
                const v = profile.profile?.answers[q.id];
                return typeof v === "string" && v.trim().length > 0;
              });
              if (answered.length === 0) return null;
              return (
                <div key={step.step} className="v2-set__profile-group">
                  <div className="v2-set__profile-group-title">{step.title}</div>
                  <div style={{ display: "grid", gap: "var(--s-3)" }}>
                    {answered.map((q) => (
                      <div key={q.id}>
                        <div className="v2-set__profile-question">{q.label}</div>
                        <div className="v2-set__profile-answer">
                          {profile.profile?.answers[q.id]}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ) : (
        <section className="v2-set__section">
          <p className="v2-set__hint">
            No user profile saved yet. Start the wizard to give Jarvis a strong initial
            understanding of your identity, goals, preferences, routines, and context.
          </p>
        </section>
      )}

      <OnboardingReplaySection onToast={onToast} />
    </div>
  );
}

/**
 * Phase E — quick-access replay buttons for the conversational profile
 * interview and the spotlight tutorial. These are shortcuts to the
 * matching scope on `/api/onboarding/reset` (also reachable from
 * Settings → General → Onboarding for the full scope dropdown, by voice
 * with "replay onboarding", or via the URL trigger).
 */
function OnboardingReplaySection({
  onToast,
}: {
  onToast: (text: string, tone?: "ok" | "warn") => void;
}) {
  const [busy, setBusy] = useState<"interview" | "tutorial" | null>(null);

  const replay = async (scope: "profile" | "tutorial") => {
    const label =
      scope === "profile"
        ? "Re-run the profile interview? Your saved profile facts will be cleared first. The page will reload."
        : "Replay the dashboard tutorial? The page will reload.";
    if (!confirm(label)) return;
    setBusy(scope === "profile" ? "interview" : "tutorial");
    try {
      await resetOnboarding(scope);
      onToast("Replay queued — reloading…", "ok");
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err), "warn");
      setBusy(null);
    }
  };

  return (
    <section className="v2-set__section">
      <div className="v2-set__section-head">
        <div>
          <h3 className="v2-set__section-title">Replay onboarding</h3>
          <div className="v2-set__section-sub">
            Re-run the conversational interview to refresh what Jarvis knows about
            you, or take the dashboard tour again.
          </div>
        </div>
      </div>
      <div style={{ display: "flex", gap: "var(--s-2)", flexWrap: "wrap" }}>
        <button
          type="button"
          className="v2-set__btn"
          onClick={() => replay("profile")}
          disabled={busy !== null}
        >
          {busy === "interview" ? "Restarting…" : "Re-run profile interview"}
        </button>
        <button
          type="button"
          className="v2-set__btn"
          onClick={() => replay("tutorial")}
          disabled={busy !== null}
        >
          {busy === "tutorial" ? "Restarting…" : "Replay tutorial"}
        </button>
      </div>
    </section>
  );
}

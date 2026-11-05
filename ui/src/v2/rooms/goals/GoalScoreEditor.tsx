import React, { useEffect, useId, useState } from "react";

type Draft = { score: number; reason: string };
const memory = new Map<string, Draft>();
const keyFor = (id: string) => `jarvis:goal-score-draft:${id}`;
function readDraft(id: string): Draft | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(keyFor(id)) ?? "null");
    if (value && typeof value.score === "number" && Number.isFinite(value.score) && value.score >= 0 && value.score <= 1 && typeof value.reason === "string") return value;
  } catch { /* storage unavailable or corrupt: retain this tab's in-memory draft */ }
  return memory.get(id) ?? null;
}
function storeDraft(id: string, value: Draft | null): boolean {
  if (value) memory.set(id, value); else memory.delete(id);
  try {
    if (value) sessionStorage.setItem(keyFor(id), JSON.stringify(value)); else sessionStorage.removeItem(keyFor(id));
    memory.delete(id);
    return true;
  } catch { return false; }
}

/** Tab-local drafts survive route changes and reloads; only explicit Save writes the goal. */
export function GoalScoreEditor({ goalId, score, onSave }: {
  goalId: string; score: number;
  onSave: (score: number, reason: string) => Promise<{ ok: boolean; message: string }>;
}) {
  const [draft, setDraft] = useState<Draft | null>(() => readDraft(goalId));
  const [savedScore, setSavedScore] = useState(score);
  const [persisted, setPersisted] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  useEffect(() => { setSavedScore(score); }, [score]);
  useEffect(() => { if (draft) setPersisted(storeDraft(goalId, draft)); }, [goalId]);
  useEffect(() => {
    if (!draft || persisted) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [draft, persisted]);
  const value = draft ?? { score: savedScore, reason: "" };
  const change = (next: Draft) => { setDraft(next); setPersisted(storeDraft(goalId, next)); setError(null); };
  const discard = () => { storeDraft(goalId, null); setDraft(null); setError(null); };
  const save = async () => {
    if (saving || !draft) return;
    setSaving(true); setError(null);
    try {
      const result = await onSave(draft.score, draft.reason.trim() || "Updated via dashboard");
      if (result.ok) { setSavedScore(draft.score); discard(); }
      else setError(result.message);
    } catch { setError("Could not save score. Your draft is kept. Try again."); }
    finally { setSaving(false); }
  };
  return <section className="v2-goals__side-section" aria-label="Update goal score">
    <label htmlFor={`${id}-score`} className="v2-goals__side-label">Score · {(value.score * 100).toFixed(0)}%</label>
    <input id={`${id}-score`} aria-label="Goal score" type="range" min={0} max={100} step={5}
      value={Math.round(value.score * 100)} disabled={saving} className="v2-goals__score-slider"
      onChange={e => change({ ...value, score: Number(e.target.value) / 100 })} />
    <label htmlFor={`${id}-reason`} className="v2-goals__side-label">Reason for the change</label>
    <input id={`${id}-reason`} type="text" className="v2-goals__input" value={value.reason} disabled={saving}
      placeholder="Reason for the change…" onChange={e => change({ ...value, reason: e.target.value })} />
    {draft && <p role="status" className="v2-goals__side-text">{persisted ? "Unsaved score draft kept in this browser tab." : "Unsaved score draft. Browser storage is unavailable; save before refreshing."}</p>}
    {error && <p role="alert">{error}</p>}
    <div className="v2-goals__chip-row">
      <button type="button" className="v2-goals__btn v2-goals__btn--primary" disabled={!draft || saving} onClick={() => void save()}>{saving ? "Saving…" : "Save score"}</button>
      {draft && <button type="button" className="v2-goals__btn v2-goals__btn--secondary" disabled={saving} onClick={discard}>Discard score draft</button>}
    </div>
  </section>;
}

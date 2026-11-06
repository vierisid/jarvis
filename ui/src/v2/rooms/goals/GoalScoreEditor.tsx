import React, { useEffect, useId, useState } from "react";
import type { Goal, ScoreResult } from "./useGoalsData";

/** The server revision a draft was started from, so a save cannot silently overwrite a newer score. */
type Draft = { score: number; reason: string; baseScore: number; baseUpdatedAt: number };
type Basis = { score: number; updated_at: number };
/** Which dashboard owner a draft belongs to. `persistent` is false when the owner could not be verified. */
export type GoalDraftScope = { key: string; persistent: boolean };

// Drafts kept here only when browser storage refuses a write. Never shared across owners.
const memory = new Map<string, Draft>();
let memoryScope: string | null = null;
function adoptScope(scope: string) {
  if (memoryScope !== scope) memory.clear();
  memoryScope = scope;
}
const keyFor = (scope: string, goalId: string) => `jarvis:goal-score-draft:v2:${encodeURIComponent(scope)}:${encodeURIComponent(goalId)}`;
const isDraft = (value: any): value is Draft => !!value && typeof value.reason === "string"
  && [value.score, value.baseScore].every(n => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1)
  && typeof value.baseUpdatedAt === "number" && Number.isFinite(value.baseUpdatedAt);
const sameScore = (a: number, b: number) => Math.abs(a - b) < 0.005;
const percent = (score: number) => `${(score * 100).toFixed(0)}%`;

/** The in-memory copy is newer than storage whenever it exists: it is only kept after a failed write. */
function readDraft(scope: GoalDraftScope, goalId: string): Draft | null {
  const key = keyFor(scope.key, goalId), held = memory.get(key);
  if (held || !scope.persistent) return held ?? null;
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? "null");
    if (isDraft(value)) return value;
  } catch { /* storage unavailable or corrupt */ }
  return null;
}
function storeDraft(scope: GoalDraftScope, goalId: string, value: Draft | null): boolean {
  const key = keyFor(scope.key, goalId);
  if (value) memory.set(key, value); else memory.delete(key);
  if (!scope.persistent) return false;
  try {
    if (value) sessionStorage.setItem(key, JSON.stringify(value)); else sessionStorage.removeItem(key);
    memory.delete(key);
    return true;
  } catch {
    // A full store may still allow removal; an older stored draft must not return after a reload.
    try { sessionStorage.removeItem(key); } catch { /* storage unavailable */ }
    return false;
  }
}

/** Reads the dashboard owner once per mount; drafts held for another owner are dropped. */
export function useGoalDraftScope(enabled: boolean): GoalDraftScope | null {
  const [scope, setScope] = useState<GoalDraftScope | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void (async () => {
      let next: GoalDraftScope;
      try {
        const response = await fetch("/api/brief/host", { cache: "no-store" });
        // A daemon without a host descriptor serves a single local owner.
        if (response.status === 404 || response.status === 501) next = { key: "local", persistent: true };
        else {
          if (!response.ok) throw new Error("Host unavailable");
          const host = await response.json() as { scopeId?: unknown; workspaceId?: unknown; generation?: unknown };
          if (typeof host?.scopeId !== "string" || !host.scopeId) throw new Error("Host unavailable");
          const workspace = typeof host.workspaceId === "string" && host.workspaceId ? host.workspaceId : String(host.generation ?? "");
          next = { key: JSON.stringify([host.scopeId, workspace]), persistent: true };
        }
      } catch { next = { key: "unverified", persistent: false }; }
      if (!live) return;
      adoptScope(next.key); setScope(next);
    })();
    return () => { live = false; };
  }, [enabled]);
  return scope;
}

/** Tab-local drafts survive route changes and reloads; only an explicit Save writes the goal. */
export function GoalScoreEditor({ goal, scope, onSave }: {
  goal: Goal; scope: GoalDraftScope;
  onSave: (score: number, reason: string, expectedUpdatedAt: number) => Promise<ScoreResult>;
}) {
  const goalId = goal.id;
  const [draft, setDraft] = useState<Draft | null>(() => readDraft(scope, goalId));
  // The newest server copy a refused save reported, until the room's own data catches up.
  const [reported, setReported] = useState<Basis | null>(null);
  const [persisted, setPersisted] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const latest: Basis = reported && reported.updated_at > goal.updated_at ? reported : { score: goal.score, updated_at: goal.updated_at };
  const conflict = !!draft && latest.updated_at !== draft.baseUpdatedAt && !sameScore(latest.score, draft.baseScore);
  const keep = (next: Draft | null) => {
    setDraft(next);
    const stored = storeDraft(scope, goalId, next);
    setPersisted(next ? stored : true);
  };

  useEffect(() => { if (draft) setPersisted(storeDraft(scope, goalId, draft)); }, [goalId]);
  useEffect(() => {
    if (!draft || saving) return;
    // Equal to the saved score with no reason: nothing to save.
    if (sameScore(draft.score, latest.score) && !draft.reason.trim()) keep(null);
    // Something other than the score moved (status, health): follow it silently.
    else if (latest.updated_at !== draft.baseUpdatedAt && sameScore(latest.score, draft.baseScore)) keep({ ...draft, baseUpdatedAt: latest.updated_at });
  }, [latest.score, latest.updated_at, draft, saving]);
  useEffect(() => {
    if (!draft || persisted) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [draft, persisted]);

  if (goal.measurement) return <section className="v2-goals__side-section" aria-label="Goal score">
    <div className="v2-goals__side-label">Score · {percent(goal.score)}</div>
    <p className="v2-goals__side-text">This score comes from the goal's measurements. Record a new measurement to update it.</p>
  </section>;

  const value = draft ?? { score: latest.score, reason: "" };
  const change = (next: { score: number; reason: string }) => {
    setError(null);
    if (sameScore(next.score, latest.score) && !next.reason.trim()) return keep(null);
    keep({ ...next, baseScore: draft?.baseScore ?? latest.score, baseUpdatedAt: draft?.baseUpdatedAt ?? latest.updated_at });
  };
  const discard = () => { keep(null); setError(null); };
  const save = async () => {
    if (saving || !draft) return;
    // Saving after a conflict is the user's explicit choice to replace the newer score.
    const current = conflict ? { ...draft, baseScore: latest.score, baseUpdatedAt: latest.updated_at } : draft;
    if (conflict) keep(current);
    setSaving(true); setError(null);
    try {
      const result = await onSave(current.score, current.reason.trim() || "Updated via dashboard", current.baseUpdatedAt);
      if (result.ok) discard();
      else if (result.conflict) {
        setReported({ score: result.conflict.score, updated_at: result.conflict.updated_at });
        // Only something other than the score moved; the draft follows it, but the user still decides to save.
        if (sameScore(result.conflict.score, current.baseScore))
          setError(`The goal changed since your draft; its score is still ${percent(result.conflict.score)}. Save again to apply your draft.`);
      }
      else setError(result.message);
    } catch { setError("Could not save score. Your draft is kept. Try again."); }
    finally { setSaving(false); }
  };
  return <section className="v2-goals__side-section" aria-label="Update goal score">
    <label htmlFor={`${id}-score`} className="v2-goals__side-label">Score · {percent(value.score)}</label>
    <input id={`${id}-score`} aria-label="Goal score" type="range" min={0} max={100} step={5}
      value={Math.round(value.score * 100)} disabled={saving} className="v2-goals__score-slider"
      onChange={e => change({ ...value, score: Number(e.target.value) / 100 })} />
    <label htmlFor={`${id}-reason`} className="v2-goals__side-label">Reason for the change</label>
    <input id={`${id}-reason`} type="text" className="v2-goals__input" value={value.reason} disabled={saving}
      placeholder="Reason for the change…" onChange={e => change({ ...value, reason: e.target.value })} />
    {draft && conflict && <p role="status" className="v2-goals__side-text" data-score-conflict>
      Score changed to {percent(latest.score)} since your draft (it was {percent(draft.baseScore)}). Your draft is kept: save it over the new score or discard it.
    </p>}
    {draft && !conflict && <p role="status" className="v2-goals__side-text">{persisted ? "Unsaved score draft kept in this browser tab." : "Unsaved score draft. Browser storage is unavailable; save before refreshing."}</p>}
    {draft && conflict && !persisted && <p role="status" className="v2-goals__side-text">Browser storage is unavailable; save before refreshing.</p>}
    {error && <p role="alert">{error}</p>}
    <div className="v2-goals__chip-row">
      <button type="button" className="v2-goals__btn v2-goals__btn--primary" disabled={!draft || saving} onClick={() => void save()}>{saving ? "Saving…" : conflict ? "Save over new score" : "Save score"}</button>
      {draft && <button type="button" className="v2-goals__btn v2-goals__btn--secondary" disabled={saving} onClick={discard}>Discard score draft</button>}
    </div>
  </section>;
}

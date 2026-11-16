import React, { useRef, useState } from "react";
import { BriefButton, BriefInput } from "../../components/controls";
import type { Flow } from "../../../v2/rooms/workflows/useWorkflowsData";

const MAX_MINUTES = 1440;
const own = (minutes: number) => `Saves ${minutes} min per run. You set this.`;

/** Minutes each successful run adds to Today's time saved: the owner's number, or an estimate from the steps. */
export function TimeSavedPerRun({ flow, request, onChanged }: { flow: Flow; request: typeof fetch; onChanged?: () => void }) {
  const [saved, setSaved] = useState<{ value: number | null } | null>(null);
  const [editing, setEditing] = useState(false), [draft, setDraft] = useState(""), [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const acting = useRef(false);
  const set = saved ? saved.value : flow.timeSavedPerRun ?? null;
  const estimate = flow.estimatedTimeSavedPerRun ?? null;
  const parsed = /^\d+$/.test(draft.trim()) ? Number(draft.trim()) : null;
  const invalid = parsed === null || parsed > MAX_MINUTES;

  async function save(value: number | null) {
    if (acting.current) return;
    acting.current = true; setBusy(true); setMessage(null);
    try {
      const response = await request(`/api/workflows/${encodeURIComponent(flow.id)}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ timeSavedPerRun: value }),
      });
      if (!response.ok) { setMessage("Could not save. Try again."); return; }
      setSaved({ value }); setEditing(false); onChanged?.();
    } catch { setMessage("Could not save. Check the connection and try again."); }
    finally { acting.current = false; setBusy(false); }
  }

  return <section className="brief-canvas-time-saved" aria-label="Time saved per run">
    {editing ? <form onSubmit={event => { event.preventDefault(); if (!invalid) void save(parsed); }}>
      <BriefInput label="Minutes saved per run" type="text" inputMode="numeric" autoFocus value={draft} disabled={busy}
        onChange={event => setDraft(event.target.value)} hint={`A whole number from 0 to ${MAX_MINUTES}.`}
        error={draft && invalid ? `Enter a whole number from 0 to ${MAX_MINUTES}.` : undefined} />
      <BriefButton size="sm" variant="primary" type="submit" disabled={invalid || busy}>Save</BriefButton>
      <BriefButton size="sm" disabled={busy} onClick={() => { setEditing(false); setMessage(null); }}>Cancel</BriefButton>
    </form> : <>
      <p>{set !== null ? own(set) : estimate !== null ? `Saves about ${estimate} min per run, estimated from the steps.` : "Time saved per run is not set."}</p>
      <BriefButton size="sm" onClick={() => { setDraft(String(set ?? estimate ?? "")); setMessage(null); setEditing(true); }}>
        {set !== null ? "Change" : "Set minutes"}
      </BriefButton>
      {set !== null && <BriefButton size="sm" disabled={busy} onClick={() => void save(null)}>Use the estimate</BriefButton>}
    </>}
    {message && <span role="alert">{message}</span>}
  </section>;
}

import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import { BriefButton, BriefSelect } from "../../components/controls";

type Keep = "forever" | "1y" | "90d" | "30d";
const CHOICES: { id: Keep; label: string; phrase: string }[] = [
  { id: "forever", label: "Forever", phrase: "" },
  { id: "1y", label: "1 year", phrase: "a year" },
  { id: "90d", label: "90 days", phrase: "90 days" },
  { id: "30d", label: "30 days", phrase: "30 days" },
];
interface Summary { keep: Keep; runs: number; bytes: number }

const ENDPOINT = "/api/workflows/run-history";

/** "8.2 MB", "340 KB": the size of what is kept, in words an owner reads. */
export function formatHistorySize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function historyLine(summary: Summary): string {
  if (summary.runs === 0) return "No workflow runs are stored yet.";
  const runs = `${summary.runs.toLocaleString("en-US")} ${summary.runs === 1 ? "run" : "runs"}`;
  return `Stored now: ${runs}, about ${formatHistorySize(summary.bytes)}.`;
}

/**
 * "Keep run history for": how long finished workflow runs are kept. Forever is
 * the default and needs no confirmation; a limit says how many runs it would
 * delete first, because that cannot be undone.
 */
export function RunHistoryRetention() {
  const id = useId();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [failed, setFailed] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<{ keep: Keep; runs: number } | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch(ENDPOINT);
      if (!res.ok) throw new Error(String(res.status));
      const body = await res.json();
      if (alive.current) { setSummary({ keep: body.keep, runs: body.runs, bytes: body.bytes }); setFailed(false); }
    } catch { if (alive.current) setFailed(true); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const save = useCallback(async (keep: Keep) => {
    setBusy(true); setMessage(""); setConfirm(null);
    try {
      const res = await fetch(ENDPOINT, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ keep }) });
      if (!res.ok) throw new Error(String(res.status));
      if (alive.current) setMessage(keep === "forever" ? "Saved. Run history is kept forever." : "Saved. Older finished runs are being cleared.");
      await load();
    } catch { if (alive.current) setMessage("Could not save that. Try again."); }
    finally { if (alive.current) setBusy(false); }
  }, [load]);

  const choose = useCallback(async (keep: Keep) => {
    if (!summary || keep === summary.keep) return;
    if (keep === "forever") return save(keep);
    setBusy(true); setMessage("");
    try {
      const res = await fetch(`${ENDPOINT}?keep=${keep}`);
      if (!res.ok) throw new Error(String(res.status));
      const body = await res.json();
      if (!alive.current) return;
      setBusy(false);
      if (body.wouldRemoveRuns > 0) setConfirm({ keep, runs: body.wouldRemoveRuns });
      else await save(keep);
    } catch { if (alive.current) { setBusy(false); setMessage("Could not check that. Try again."); } }
  }, [summary, save]);

  const phrase = (keep: Keep) => CHOICES.find((c) => c.id === keep)!.phrase;
  return (
    <section aria-labelledby={`${id}-history`}>
      <h2 id={`${id}-history`}>Run history</h2>
      <div className="brief-settings-row brief-settings-voice">
        <div>
          <h3>Keep run history for</h3>
          <p>
            {failed ? "Run history could not be read right now." : summary ? historyLine(summary) : "Loading…"}
            {" "}Runs that are waiting for you are never deleted.
          </p>
        </div>
        <BriefSelect
          label="Keep run history for"
          value={confirm?.keep ?? summary?.keep ?? "forever"}
          disabled={!summary || busy || confirm !== null}
          onChange={(e) => void choose(e.target.value as Keep)}
        >
          {CHOICES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </BriefSelect>
      </div>
      {confirm && (
        <div className="brief-settings-feedback" role="alertdialog" aria-label="Confirm clearing run history">
          <p>
            This deletes {confirm.runs.toLocaleString("en-US")} finished {confirm.runs === 1 ? "run" : "runs"} older
            than {phrase(confirm.keep)}, with their logs. It cannot be undone.
          </p>
          <div>
            <BriefButton variant="text" onClick={() => setConfirm(null)}>Keep everything</BriefButton>
            <BriefButton variant="primary" onClick={() => void save(confirm.keep)}>Delete older runs</BriefButton>
          </div>
        </div>
      )}
      <p role="status" aria-live="polite" className="brief-settings-action-status">{message}</p>
    </section>
  );
}

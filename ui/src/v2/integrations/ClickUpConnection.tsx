import React, {useCallback, useEffect, useRef, useState} from "react";
import "./clickup.css";
export interface ClickUpStatus {
  configured: boolean; connected: boolean; connect_url: string | null; external_id: string;
  account: {id: string; label: string} | null; workspaces: Array<{id: string; name: string}>;
  generation: string | null;
}
export function ClickUpConnection({onPick, currentValue, optional = false}: {
  onPick?: (value: string) => void; currentValue?: string; optional?: boolean;
}) {
  const [status, setStatus] = useState<ClickUpStatus | null>(null);
  const [error, setError] = useState("");
  const [waiting, setWaiting] = useState(false);
  const started = useRef(0);
  const initialGeneration = useRef<string | null>(null);
  const live = useRef(true);
  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/integrations/clickup");
      if (!response.ok) throw new Error("Could not check ClickUp. Try again.");
      const next: ClickUpStatus = await response.json();
      if (!live.current) return;
      setStatus(next); setError("");
      if (next.generation !== initialGeneration.current) setWaiting(false);
    } catch (e) { if (live.current) setError(e instanceof Error ? e.message : "Could not check ClickUp."); }
  }, []);
  useEffect(() => {
    live.current = true; void load();
    const refresh = () => {void load();};
    window.addEventListener("focus", refresh);
    return () => { live.current = false; window.removeEventListener("focus", refresh); };
  }, [load]);
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setInterval(() => {
      if (Date.now() - started.current > 120_000) {setWaiting(false); setError("Finish any changes in the account page, then check again.");}
      else void load();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [waiting, load]);
  if (optional && status && !status.configured && !status.connected) return null;
  return <section className="clickup-connection" aria-label="ClickUp connection">
    <div><h3>ClickUp</h3><p>Find, create and update tasks in your connected workspace.</p></div>
    {!status && !error && <p role="status">Checking connection…</p>}
    {status?.connected && <p role="status">Connected as {status.account?.label}. {status.workspaces.map(w => w.name).join(", ")}</p>}
    {error && <p role="alert">{error}</p>}
    {status && !status.configured && !status.connected && <p>Hosted ClickUp setup is not available on this instance. Existing manually configured workflow accounts can still be used.</p>}
    <div className="clickup-connection__actions">
      {status?.connect_url && <a className="clickup-connection__button" href={status.connect_url} target="_blank" rel="noopener noreferrer"
        onClick={() => {initialGeneration.current = status.generation; started.current = Date.now(); setWaiting(true); setError("");}}>
        {status.connected ? "Manage ClickUp connection" : "Connect ClickUp"}
      </a>}
      {(waiting || error) && <button type="button" onClick={() => void load()}>{waiting ? "Check connection" : "Try again"}</button>}
      {waiting && <p role="status">Finish connecting in the account page, then return here.</p>}
      {onPick && status?.connected && <button type="button" onClick={() => onPick("{{connections." + status.external_id + "}}")}
        disabled={currentValue === "{{connections." + status.external_id + "}}"}>
        {currentValue === "{{connections." + status.external_id + "}}" ? "Account selected" : "Use this account"}
      </button>}
    </div>
  </section>;
}

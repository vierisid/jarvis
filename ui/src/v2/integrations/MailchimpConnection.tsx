import React, {useCallback, useEffect, useRef, useState} from "react";
import {Check, Mail} from "lucide-react";
import {Button} from "../ui/Button";
import "./mailchimp.css";
export interface MailchimpStatus {
  configured: boolean; connected: boolean; connect_url: string | null; external_id: string;
  account: {id: string; label: string} | null; workspaces: Array<{id: string; name: string}>;
  generation: string | null;
}
export function MailchimpConnection({onPick, currentValue, optional = false, appearance = "inline"}: {
  onPick?: (value: string) => void; currentValue?: string; optional?: boolean;
  appearance?: "inline" | "onboarding";
}) {
  const [status, setStatus] = useState<MailchimpStatus | null>(null);
  const [error, setError] = useState("");
  const [waiting, setWaiting] = useState(false);
  const started = useRef(0);
  const initialGeneration = useRef<string | null>(null);
  const live = useRef(true);
  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/integrations/mailchimp");
      if (!response.ok) throw new Error("Could not check Mailchimp. Try again.");
      const next: MailchimpStatus = await response.json();
      if (!live.current) return;
      setStatus(next); setError("");
      if (next.generation !== initialGeneration.current) setWaiting(false);
    } catch (e) { if (live.current) setError(e instanceof Error ? e.message : "Could not check Mailchimp."); }
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
  const beginConnect = () => {
    initialGeneration.current = status?.generation ?? null;
    started.current = Date.now(); setWaiting(true); setError("");
  };
  if (appearance === "onboarding") return <section className="mailchimp-onboarding" aria-label="Mailchimp connection">
    <div className="on-google__service" data-state={status?.connected ? "connected" : "idle"}>
      <span className="on-google__icon" aria-hidden="true"><Mail size={18} strokeWidth={1.5} /></span>
      <div className="on-google__details">
        <h2>Mailchimp</h2>
        <p className="on-google__access">Find subscribers, sync tags and read campaign reports.</p>
        <p className="on-google__account" role="status">{status?.connected
          ? <>Connected as {status.account?.label}. {status.workspaces.map(w => w.name).join(", ")}</>
          : !status && !error ? "Checking connection…" : ""}</p>
      </div>
      {status?.connect_url ? <a className="on-google__control on-google__connect mailchimp-onboarding__link"
        href={status.connect_url} target="_blank" rel="noopener noreferrer" onClick={beginConnect}
        aria-label={status.connected ? "Manage Mailchimp connection" : "Connect Mailchimp"}>
        {status.connected && <Check size={14} aria-hidden="true" />}{status.connected ? "Manage" : "Connect"}
      </a> : <Button className="on-google__control on-google__connect" disabled>
        {status || error ? "Unavailable" : "Checking…"}
      </Button>}
    </div>
    {(error || waiting) && <div className="on-google__connection-feedback mailchimp-onboarding__feedback">
      {error && <p role="alert">{error}</p>}
      {waiting && <p role="status">Finish connecting in the account page, then return here.</p>}
      <Button className="on-google__control" onClick={() => void load()}>{waiting ? "Check connection" : "Try again"}</Button>
    </div>}
  </section>;
  return <section className="mailchimp-connection" aria-label="Mailchimp connection">
    <div><h3>Mailchimp</h3><p>Find subscribers, sync tags and read campaign reports.</p></div>
    {!status && !error && <p role="status">Checking connection…</p>}
    {status?.connected && <p role="status">Connected as {status.account?.label}. {status.workspaces.map(w => w.name).join(", ")}</p>}
    {onPick && <p>Use subscriber lookup, tag updates and campaign reports. Tag updates do not start Mailchimp automations. Campaign sending and triggers are not enabled.</p>}
    {error && <p role="alert">{error}</p>}
    {status && !status.configured && !status.connected && <p>Hosted Mailchimp setup is not available on this instance. Existing manually configured workflow accounts can still be used.</p>}
    <div className="mailchimp-connection__actions">
      {status?.connect_url && <a className="mailchimp-connection__button" href={status.connect_url} target="_blank" rel="noopener noreferrer"
        onClick={beginConnect}>
        {status.connected ? "Manage Mailchimp connection" : "Connect Mailchimp"}
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

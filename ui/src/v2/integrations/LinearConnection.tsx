import React, { useCallback, useEffect, useRef, useState } from "react";
import { Check, CircleDot } from "lucide-react";
import { Button } from "../ui/Button";
import "./clickup.css";
export interface LinearStatus {
  configured: boolean;
  connected: boolean;
  reconnect?: boolean;
  connect_url: string | null;
  external_id: string;
  account: { id: string; label: string } | null;
  workspaces: Array<{ id: string; name: string }>;
  generation: string | null;
}
/** The managed Linear connection's status, re-read when the window regains
 * focus; null until known, and on any failure (callers then fall back to the
 * manual fields, which work on every install). */
export function useLinearStatus(enabled = true): LinearStatus | null {
  const [status, setStatus] = useState<LinearStatus | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const load = () =>
      fetch("/api/integrations/linear")
        .then((r) => (r.ok ? (r.json() as Promise<LinearStatus>) : null))
        .then(
          (next) => {
            if (live) setStatus(next);
          },
          () => {
            if (live) setStatus(null);
          },
        );
    void load();
    window.addEventListener("focus", load);
    return () => {
      live = false;
      window.removeEventListener("focus", load);
    };
  }, [enabled]);
  return enabled ? status : null;
}
export function LinearConnection({
  onPick,
  currentValue,
  optional = false,
  appearance = "inline",
}: {
  onPick?: (value: string) => void;
  currentValue?: string;
  optional?: boolean;
  appearance?: "inline" | "onboarding";
}) {
  const [status, setStatus] = useState<LinearStatus | null>(null);
  const [error, setError] = useState("");
  const [waiting, setWaiting] = useState(false);
  const started = useRef(0);
  const initialGeneration = useRef<string | null>(null);
  const live = useRef(true);
  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/integrations/linear");
      if (!response.ok) throw new Error("Could not check Linear. Try again.");
      const next: LinearStatus = await response.json();
      if (!live.current) return;
      setStatus(next);
      setError("");
      if (next.generation !== initialGeneration.current) setWaiting(false);
    } catch (e) {
      if (live.current)
        setError(e instanceof Error ? e.message : "Could not check Linear.");
    }
  }, []);
  useEffect(() => {
    live.current = true;
    void load();
    const refresh = () => {
      void load();
    };
    window.addEventListener("focus", refresh);
    return () => {
      live.current = false;
      window.removeEventListener("focus", refresh);
    };
  }, [load]);
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setInterval(() => {
      if (Date.now() - started.current > 120_000) {
        setWaiting(false);
        setError("Finish any changes in the account page, then check again.");
      } else void load();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [waiting, load]);
  if (optional && status && !status.configured && !status.connected)
    return null;
  const beginConnect = () => {
    initialGeneration.current = status?.generation ?? null;
    started.current = Date.now();
    setWaiting(true);
    setError("");
  };
  if (appearance === "onboarding")
    return (
      <section className="clickup-onboarding" aria-label="Linear connection">
        <div
          className="on-google__service"
          data-state={status?.connected ? "connected" : "idle"}
        >
          <span className="on-google__icon" aria-hidden="true">
            <CircleDot size={18} strokeWidth={1.5} />
          </span>
          <div className="on-google__details">
            <h2>Linear</h2>
            <p className="on-google__access">
              Find, create and update issues, and add comments in your
              workspace.
            </p>
            <p className="on-google__account" role="status">
              {status?.connected ? (
                <>
                  Connected as {status.account?.label}.{" "}
                  {status.workspaces.map((w) => w.name).join(", ")}
                </>
              ) : status?.reconnect ? (
                "Access has expired. Reconnect Linear."
              ) : !status && !error ? (
                "Checking connection…"
              ) : (
                ""
              )}
            </p>
          </div>
          {status?.connect_url ? (
            <a
              className="on-google__control on-google__connect clickup-onboarding__link"
              href={status.connect_url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={beginConnect}
              aria-label={
                status.connected ? "Manage Linear connection" : "Connect Linear"
              }
            >
              {status.connected && <Check size={14} aria-hidden="true" />}
              {status.connected ? "Manage" : "Connect"}
            </a>
          ) : (
            <Button className="on-google__control on-google__connect" disabled>
              {status || error ? "Unavailable" : "Checking…"}
            </Button>
          )}
        </div>
        {(error || waiting) && (
          <div className="on-google__connection-feedback clickup-onboarding__feedback">
            {error && <p role="alert">{error}</p>}
            {waiting && (
              <p role="status">
                Finish connecting in the account page, then return here.
              </p>
            )}
            <Button className="on-google__control" onClick={() => void load()}>
              {waiting ? "Check connection" : "Try again"}
            </Button>
          </div>
        )}
      </section>
    );
  return (
    <section className="clickup-connection" aria-label="Linear connection">
      <div>
        <h3>Linear</h3>
        <p>
          Find, create and update issues, and add comments in your workspace.
        </p>
      </div>
      {!status && !error && <p role="status">Checking connection…</p>}
      {status?.connected && (
        <p role="status">
          Connected as {status.account?.label}.{" "}
          {status.workspaces.map((w) => w.name).join(", ")}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {status && !status.configured && !status.connected && (
        <p>
          Hosted Linear setup is not available on this instance. Existing
          manually configured workflow accounts can still be used.
        </p>
      )}
      {status?.reconnect && (
        <p role="alert">
          Linear access needs reconnecting. Open your account page to reconnect.
        </p>
      )}
      <div className="clickup-connection__actions">
        {status?.connect_url && (
          <a
            className="clickup-connection__button"
            href={status.connect_url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={beginConnect}
          >
            {status.connected ? "Manage Linear connection" : "Connect Linear"}
          </a>
        )}
        {(waiting || error) && (
          <button type="button" onClick={() => void load()}>
            {waiting ? "Check connection" : "Try again"}
          </button>
        )}
        {waiting && (
          <p role="status">
            Finish connecting in the account page, then return here.
          </p>
        )}
        {onPick && status?.connected && (
          <button
            type="button"
            onClick={() => onPick("{{connections." + status.external_id + "}}")}
            disabled={
              currentValue === "{{connections." + status.external_id + "}}"
            }
          >
            {currentValue === "{{connections." + status.external_id + "}}"
              ? "Account selected"
              : "Use this account"}
          </button>
        )}
      </div>
    </section>
  );
}

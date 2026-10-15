import { useId } from "react";
import { CalendarDays, Check } from "lucide-react";
import { Button } from "../../../v2/ui/Button";
import "./google.css";

/** Local projection of google-state.v1. Only the provider verifies a grant. */
export type GoogleConnectionState =
  | { state: "idle" }
  | { state: "pending"; attemptId: string; accountLabel?: string }
  | { state: "connected"; attemptId: string | null; accountLabel: string; grantedAccessSummary: string }
  | { state: "cancelled" | "expired"; attemptId: string }
  | { state: "error"; attemptId: string | null; message: string }
  | { state: "unavailable"; message: string };

export interface GoogleModel {
  theme: "light" | "dark";
  connection: GoogleConnectionState;
  navigation: { kind: "ready" } | { kind: "pending" | "error"; message: string };
  /** Journey-owned position; omit until known rather than invent a step count. */
  progress?: { current: number; total: number };
}

export interface GoogleViewProps {
  model: GoogleModel;
  onConnect: () => void;
  onCancel: (attemptId: string) => void;
  onBack: () => void;
  onSkip: () => void;
  onContinue: () => void;
}

function feedback(connection: GoogleConnectionState): string {
  switch (connection.state) {
    case "idle": return "";
    case "pending": return "Waiting for Google. Finish sign-in in your browser, then return here.";
    case "connected": return "Google connection confirmed.";
    case "cancelled": return "Sign-in cancelled. Try again, or skip for now.";
    case "expired": return "Sign-in expired. Try again to start a new connection.";
    case "error": return connection.message.trim() || "Google could not be connected. Try again, or skip for now.";
    case "unavailable": return connection.message.trim() || "Google connection is unavailable. You can skip for now.";
  }
}

/** Intent-only view. No OAuth, timers, storage, external windows or setup writes. */
export function GoogleView({ model, onConnect, onCancel, onBack, onSkip, onContinue }: GoogleViewProps) {
  const headingId = useId();
  const feedbackId = useId();
  const { connection } = model;
  const busy = model.navigation.kind === "pending";
  const connected = connection.state === "connected";
  const waiting = connection.state === "pending";
  const cannotConnect = busy || connected || connection.state === "unavailable";
  const label = waiting ? "Cancel sign-in" : connected ? "Connected"
    : connection.state === "unavailable" ? "Unavailable"
    : connection.state === "idle" ? "Connect" : "Try again";
  const message = feedback(connection);
  const account = connected || waiting ? connection.accountLabel : undefined;
  const access = connected
    ? connection.grantedAccessSummary.trim() || "Granted access details are unavailable."
    : "Connect Gmail and Calendar to give Jarvis context for your day and the routines you want to automate.";
  const progress = model.progress;
  const showProgress = progress && Number.isInteger(progress.current) && Number.isInteger(progress.total)
    && progress.current >= 1 && progress.current <= progress.total && progress.total <= 20;

  return (
    <section className="on-google" data-theme={model.theme} aria-labelledby={headingId}>
      <div className="on-google__content">
        <div className="on-google__progress">
          {showProgress && <div className="on-google__segments" aria-hidden="true">
            {Array.from({ length: progress.total }, (_, i) => <span key={i} data-position={i + 1 < progress.current ? "past" : i + 1 === progress.current ? "current" : "next"} />)}
          </div>}
          <p>{showProgress ? `Step ${progress.current} of ${progress.total} · Connect` : "Connect"}</p>
        </div>
        <h1 id={headingId}>Connect your everyday tools.</h1>
        <p className="on-google__intro">Give Jarvis context from Gmail and Calendar. You can connect more tools later.</p>

        <div className="on-google__service" data-state={connection.state}>
          <span className="on-google__icon" aria-hidden="true"><CalendarDays size={18} strokeWidth={1.5} /></span>
          <div className="on-google__details">
            <h2>Google</h2>
            <p className="on-google__access">{access}</p>
            <p className="on-google__account">{account?.trim() || (connected ? "Google account" : "")}</p>
          </div>
          <Button className="on-google__control on-google__connect" aria-disabled={cannotConnect}
            aria-describedby={feedbackId} onClick={() => {
              if (cannotConnect) return;
              if (connection.state === "pending") onCancel(connection.attemptId);
              else onConnect();
            }}>
            {connected && <Check size={14} aria-hidden="true" />}{label}
          </Button>
        </div>
        <div className="on-google__connection-feedback" id={feedbackId}>
          <p role="status" aria-atomic="true" data-state={connection.state}>{connection.state !== "error" ? message : ""}</p>
          <p role="alert" aria-atomic="true">{connection.state === "error" ? message : ""}</p>
        </div>

        <div className="on-google__actions">
          <Button className="on-google__control on-google__back" aria-disabled={busy} onClick={() => { if (!busy) onBack(); }}>Back</Button>
          <Button className="on-google__control on-google__skip" aria-disabled={busy} onClick={() => { if (!busy) onSkip(); }}>Skip for now</Button>
          <Button variant="primary" className="on-google__control on-google__continue" aria-disabled={busy || waiting}
            onClick={() => { if (!busy && !waiting) onContinue(); }}>Continue</Button>
        </div>
        <div className="on-google__navigation-feedback">
          <p role="status">{model.navigation.kind === "pending" ? model.navigation.message : ""}</p>
          <p role="alert">{model.navigation.kind === "error" ? model.navigation.message : ""}</p>
        </div>
      </div>
    </section>
  );
}

/**
 * Q-19: one failure, read the same way everywhere it appears (a run, Today,
 * chat). The daemon's projection decides every word: what happened, what did
 * and did not take effect, and what the person can safely do next. This
 * component only lays it out, with the redacted evidence behind "Details".
 * It never classifies a failure itself.
 */
import React from "react";
import "./FailureNotice.css";

/** Mirrors `UserFailure` in src/failures/projection.ts. */
export interface UserFailure {
  category: string;
  effect: "none" | "unknown" | "partial";
  headline: string;
  outcome: string;
  next: Array<{ step: string; label: string }>;
  links: { runId?: string; flowId?: string; stepName?: string; effectId?: string; approvalId?: string; taskId?: string; channel?: string };
  code: string | null;
  detail: string;
  key: string;
}

export function isUserFailure(value: unknown): value is UserFailure {
  const v = value as Partial<UserFailure> | null;
  return !!v && typeof v === "object" && typeof v.headline === "string" && typeof v.outcome === "string"
    && Array.isArray(v.next) && typeof v.key === "string";
}

export interface FailureNoticeProps {
  failure: UserFailure;
  /** One line (the headline) with the rest behind a disclosure. */
  compact?: boolean;
  className?: string;
}

export function FailureNotice({ failure, compact, className }: FailureNoticeProps): React.ReactElement {
  const steps = failure.next.filter((n) => n.step !== "open_details");
  const classes = ["v2-failure", compact && "v2-failure--compact", className].filter(Boolean).join(" ");
  const body = (
    <>
      <p className="v2-failure__outcome">{failure.outcome}</p>
      {steps.length ? (
        <ul className="v2-failure__next">
          {steps.map((s) => <li key={s.step}>{s.label}</li>)}
        </ul>
      ) : null}
      {failure.detail ? (
        <details className="v2-failure__detail">
          <summary>Details</summary>
          <pre>{failure.code ? `${failure.code}\n${failure.detail}` : failure.detail}</pre>
        </details>
      ) : null}
    </>
  );
  return (
    <div className={classes} data-effect={failure.effect} role="status">
      {compact ? (
        <details className="v2-failure__compact">
          <summary className="v2-failure__headline">{failure.headline}</summary>
          {body}
        </details>
      ) : (
        <>
          <p className="v2-failure__headline">{failure.headline}</p>
          {body}
        </>
      )}
    </div>
  );
}

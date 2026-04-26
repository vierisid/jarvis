import React, { useState } from "react";
import { Check, ShieldAlert, MessageSquare, X } from "lucide-react";
import { Icon } from "../ui";
import { useLiveData } from "../shell/LiveDataContext";
import "./RailConfirmationStack.css";

/**
 * Phase 6.3.5b — pending confirmations rendered directly in the VoiceRail.
 *
 * Reads the same `approvals` / `clarifiers` / `repeatBacks` streams the
 * thread cards and notification drawer use (via LiveDataContext), then
 * renders compact cards with Approve/Cancel buttons that hit the same
 * REST endpoints. This lets the user resolve pending actions WITHOUT
 * leaving whatever Room they're in — the rail is always visible (Phase
 * 6.0) and the stack sits directly under the orb (highest salience).
 *
 * Voice-driven resolution (Phase 6.3.5b daemon-side): the user can also
 * say "approve" or "cancel" and the daemon resolves the most-recent
 * pending action server-side via `resolveLatestPendingByVoice`.
 */
export function RailConfirmationStack() {
  const { approvals, clarifiers, repeatBacks } = useLiveData();

  // Sort each kind newest-first; render in priority order: approval >
  // clarifier > repeat-back. Same priority the daemon uses for voice.
  const sortedApprovals = [...approvals].sort((a, b) => b.timestamp - a.timestamp);
  const sortedClarifiers = [...clarifiers].sort((a, b) => b.timestamp - a.timestamp);
  const sortedRepeatBacks = [...repeatBacks].sort((a, b) => b.timestamp - a.timestamp);

  const total = sortedApprovals.length + sortedClarifiers.length + sortedRepeatBacks.length;
  if (total === 0) return null;

  return (
    <div className="v2-rail-confirm" role="region" aria-label="Pending confirmations">
      <div className="v2-rail-confirm__head">
        <span className="v2-rail-confirm__label">Pending</span>
        <span className="v2-rail-confirm__count">{total}</span>
      </div>
      <div className="v2-rail-confirm__list">
        {sortedApprovals.map((a) => (
          <ApprovalRow key={a.id} id={a.id} intent={a.intent} category={a.category} impact={a.impact} />
        ))}
        {sortedClarifiers.map((c) => (
          <VoiceConfirmRow
            key={c.id}
            kind="clarifier"
            id={c.id}
            title={c.primary.label}
            transcript={c.transcript}
          />
        ))}
        {sortedRepeatBacks.map((r) => (
          <VoiceConfirmRow
            key={r.id}
            kind="repeat-back"
            id={r.id}
            title="Confirm what I heard"
            transcript={r.transcript}
          />
        ))}
      </div>
      <div className="v2-rail-confirm__voice-hint">
        Or say <em>“approve”</em> / <em>“cancel”</em>
      </div>
    </div>
  );
}

/* ─────────── Subcomponents ─────────── */

function ApprovalRow({
  id,
  intent,
  category,
  impact,
}: {
  id: string;
  intent: string;
  category: string;
  impact: "read" | "write" | "destructive" | "external";
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const post = async (path: "approve" | "deny") => {
    setBusy(true);
    setError(null);
    try {
      const resp = await fetch(`/api/authority/approvals/${encodeURIComponent(id)}/${path}`, {
        method: "POST",
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
      setBusy(false);
    }
  };

  return (
    <div className="v2-rail-confirm__card" data-tone={impactTone(impact)}>
      <div className="v2-rail-confirm__card-meta">
        <Icon icon={ShieldAlert} size="sm" />
        <span className="v2-rail-confirm__card-kind">Approval</span>
        <span className="v2-rail-confirm__card-impact" data-impact={impact}>
          {impact}
        </span>
      </div>
      <div className="v2-rail-confirm__card-title">{intent}</div>
      {category && <div className="v2-rail-confirm__card-sub">{category}</div>}
      {error && <div className="v2-rail-confirm__card-error">{error}</div>}
      <div className="v2-rail-confirm__card-actions">
        <button
          type="button"
          className="v2-rail-confirm__btn v2-rail-confirm__btn--cancel"
          onClick={() => post("deny")}
          disabled={busy}
        >
          <Icon icon={X} size="sm" />
          Cancel
        </button>
        <button
          type="button"
          className="v2-rail-confirm__btn v2-rail-confirm__btn--approve"
          onClick={() => post("approve")}
          disabled={busy}
        >
          <Icon icon={Check} size="sm" />
          Approve
        </button>
      </div>
    </div>
  );
}

function VoiceConfirmRow({
  kind,
  id,
  title,
  transcript,
}: {
  kind: "clarifier" | "repeat-back";
  id: string;
  title: string;
  transcript: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const post = async (decision: "confirm" | "cancel") => {
    setBusy(true);
    setError(null);
    try {
      const path = kind === "clarifier" ? "clarifier" : "repeat-back";
      const resp = await fetch(
        `/api/voice/${path}/${encodeURIComponent(id)}/${decision}`,
        { method: "POST" },
      );
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
      setBusy(false);
    }
  };

  return (
    <div className="v2-rail-confirm__card" data-tone="warn">
      <div className="v2-rail-confirm__card-meta">
        <Icon icon={MessageSquare} size="sm" />
        <span className="v2-rail-confirm__card-kind">
          {kind === "clarifier" ? "Clarify" : "Confirm"}
        </span>
      </div>
      <div className="v2-rail-confirm__card-title">{title}</div>
      <div className="v2-rail-confirm__card-quote">“{transcript}”</div>
      {error && <div className="v2-rail-confirm__card-error">{error}</div>}
      <div className="v2-rail-confirm__card-actions">
        <button
          type="button"
          className="v2-rail-confirm__btn v2-rail-confirm__btn--cancel"
          onClick={() => post("cancel")}
          disabled={busy}
        >
          <Icon icon={X} size="sm" />
          No
        </button>
        <button
          type="button"
          className="v2-rail-confirm__btn v2-rail-confirm__btn--approve"
          onClick={() => post("confirm")}
          disabled={busy}
        >
          <Icon icon={Check} size="sm" />
          Yes
        </button>
      </div>
    </div>
  );
}

function impactTone(impact: string): "ok" | "neutral" | "warn" | "accent" {
  if (impact === "destructive") return "accent";
  if (impact === "external") return "warn";
  return "neutral";
}

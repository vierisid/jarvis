import React from "react";
import { Mic } from "lucide-react";
import { Button, Icon } from "../ui";
import type { Impact } from "./types";
import "./ApprovalCard.css";

const IMPACT_LABEL: Record<Impact, string> = {
  read: "read",
  write: "write",
  destructive: "destructive",
  external: "external",
};

export interface ApprovalCardProps {
  /** Imperative sentence. Example: "Delete 14 files in ~/Downloads". */
  intent: string;
  category: string;
  impact: Impact;
  /** Substrings inside `intent` to highlight in accent — matched literally. */
  highlights?: string[];
  voiceHint?: string;
  onApprove?: () => void;
  onCancel?: () => void;
}

/**
 * Inline approval gate. Destructive intents ALWAYS route through this component
 * per the Authority engine — no destructive tool call bypasses it.
 */
export function ApprovalCard({
  intent,
  category,
  impact,
  highlights,
  voiceHint = `or say "yes"`,
  onApprove,
  onCancel,
}: ApprovalCardProps) {
  const impactClass =
    impact === "destructive"
      ? "v2-approval__impact--destructive"
      : impact === "external"
      ? "v2-approval__impact--external"
      : "";

  return (
    <article
      className="v2-approval"
      role="alertdialog"
      aria-label={`Approval required: ${intent}`}
    >
      <div className="v2-approval__head">
        <span className="v2-approval__label">Needs your OK</span>
        <span className={`v2-approval__impact ${impactClass}`}>
          {IMPACT_LABEL[impact]}
        </span>
        <span className="v2-approval__category">{category}</span>
      </div>

      <h3 className="v2-approval__intent">
        {renderWithHighlights(intent, highlights)}
      </h3>

      <div className="v2-approval__actions">
        <Button variant="primary" size="md" onClick={onApprove}>
          Yes · approve
        </Button>
        <Button variant="ghost" size="md" onClick={onCancel}>
          Cancel
        </Button>

        <span className="v2-approval__voice-hint" aria-hidden="true">
          <Icon icon={Mic} size="sm" />
          <span className="v2-approval__voice-hint-text">{voiceHint}</span>
        </span>
      </div>
    </article>
  );
}

function renderWithHighlights(text: string, highlights?: string[]): React.ReactNode {
  if (!highlights || highlights.length === 0) return text;

  // Escape regex specials in each highlight, then build an alternation.
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(${highlights.map(esc).join("|")})`, "g");
  const parts = text.split(pattern);

  return parts.map((part, i) => {
    if (!part) return null;
    const isMatch = highlights.some((h) => h === part);
    return isMatch ? <mark key={i}>{part}</mark> : <span key={i}>{part}</span>;
  });
}

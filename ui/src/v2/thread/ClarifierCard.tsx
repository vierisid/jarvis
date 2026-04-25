import React, { useState } from "react";
import { Mic } from "lucide-react";
import { Button, Chip, Icon } from "../ui";
import type { VoiceIntentLite } from "./types";
import "./ClarifierCard.css";

export interface ClarifierCardProps {
  transcript: string;
  primary: VoiceIntentLite;
  alternatives: VoiceIntentLite[];
  confidence: number;
  onConfirm?: () => void;
  onCancel?: () => void;
}

/**
 * Inline card for the 0.6–0.85 confidence band: the classifier has a primary
 * interpretation but isn't sure enough to act unilaterally. Mirrors the
 * approval card shape (border-left rule + accent-only confirm) but uses the
 * `--warn` left rule, since this is a comprehension check, not an authority
 * gate.
 */
export function ClarifierCard({
  transcript,
  primary,
  alternatives,
  confidence,
  onConfirm,
  onCancel,
}: ClarifierCardProps) {
  const [busy, setBusy] = useState(false);

  const click = (action: () => void | undefined) => () => {
    if (busy) return;
    setBusy(true);
    action?.();
  };

  return (
    <article
      className="v2-clarifier"
      role="alertdialog"
      aria-label={`Clarify: did you mean ${primary.label}?`}
    >
      <div className="v2-clarifier__attribution">
        <span className="v2-clarifier__attribution-dot" aria-hidden="true" />
        Jarvis
        <span className="v2-clarifier__attribution-tag">· not quite sure</span>
        <Chip tone="warn" dot={false}>{`${Math.round(confidence * 100)}%`}</Chip>
      </div>

      <div className="v2-clarifier__transcript">
        <Icon icon={Mic} size="sm" />
        <span>&ldquo;{transcript}&rdquo;</span>
      </div>

      <h3 className="v2-clarifier__primary">
        Did you mean: <em>{primary.label}</em>?
      </h3>

      {alternatives.length > 0 && (
        <ul className="v2-clarifier__alts">
          {alternatives.map((a, i) => (
            <li key={i} className="v2-clarifier__alt">
              <span className="v2-clarifier__alt-label">{a.label}</span>
              <span className="v2-clarifier__alt-meta">{a.verb} · {a.impact}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="v2-clarifier__actions">
        <Button variant="primary" size="md" disabled={busy} onClick={click(onConfirm ?? (() => undefined))}>
          Yes, do that
        </Button>
        <Button variant="ghost" size="md" disabled={busy} onClick={click(onCancel ?? (() => undefined))}>
          Cancel
        </Button>
        <span className="v2-clarifier__hint">or say &ldquo;yes&rdquo; / &ldquo;no&rdquo;</span>
      </div>
    </article>
  );
}

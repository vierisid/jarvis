import React, { useState } from "react";
import { Mic } from "lucide-react";
import { Button, Icon } from "../ui";
import "./RepeatBackCard.css";

export interface RepeatBackCardProps {
  transcript: string;
  confidence: number;
  onConfirm?: () => void;
  onCancel?: () => void;
}

/**
 * Inline card for the <0.6 confidence band: the classifier really didn't
 * understand the utterance. We echo it back verbatim and ask the user to
 * confirm before acting. Less ornate than the clarifier card — there's no
 * primary interpretation to show, just the heard transcript.
 */
export function RepeatBackCard({
  transcript,
  confidence,
  onConfirm,
  onCancel,
}: RepeatBackCardProps) {
  const [busy, setBusy] = useState(false);
  const click = (action?: () => void) => () => {
    if (busy) return;
    setBusy(true);
    action?.();
  };

  return (
    <article
      className="v2-repeatback"
      role="alertdialog"
      aria-label={`Heard transcript needs confirmation`}
    >
      <div className="v2-repeatback__attribution">
        <span className="v2-repeatback__attribution-dot" aria-hidden="true" />
        Jarvis
        <span className="v2-repeatback__attribution-tag">· didn&rsquo;t catch that</span>
        <span className="v2-repeatback__conf">{Math.round(confidence * 100)}% match</span>
      </div>

      <div className="v2-repeatback__heard">
        <Icon icon={Mic} size="sm" />
        <span className="v2-repeatback__heard-text">
          I heard: <em>&ldquo;{transcript}&rdquo;</em>
        </span>
      </div>

      <div className="v2-repeatback__actions">
        <Button variant="primary" size="md" disabled={busy} onClick={click(onConfirm)}>
          Yes, that&rsquo;s right
        </Button>
        <Button variant="ghost" size="md" disabled={busy} onClick={click(onCancel)}>
          No, try again
        </Button>
      </div>
    </article>
  );
}

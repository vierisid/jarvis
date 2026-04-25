import React from "react";
import "./TranscriptBubble.css";

/**
 * Live partial transcript shown under the orb during recording.
 * Rendered only when there's text to show — empty string returns null
 * so the rail stays quiet between utterances.
 *
 * The handoff says "live transcript under the orb (NOT in thread until final)".
 * The daemon-side STT is whole-buffer; this bubble is fed by the browser's
 * `SpeechRecognition.interimResults` running in parallel for visual feedback.
 * On browsers without `SpeechRecognition`, the bubble simply stays empty
 * (no regression — the final transcript still lands in the thread).
 */
export function TranscriptBubble({ text }: { text: string }) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  return (
    <div className="v2-transcript" role="status" aria-live="polite">
      <span className="v2-transcript__quote" aria-hidden="true">&ldquo;</span>
      <span className="v2-transcript__text">{trimmed}</span>
    </div>
  );
}

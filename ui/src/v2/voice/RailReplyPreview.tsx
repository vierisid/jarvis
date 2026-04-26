import React, { useMemo } from "react";
import { ArrowRight } from "lucide-react";
import { Icon } from "../ui";
import { useLiveData } from "../shell/LiveDataContext";
import { useV2Route, closeRoom } from "../router";
import "./RailReplyPreview.css";

const MAX_CHARS = 200;

/**
 * Phase 6.5.5 — surfaces the LAST SENTENCE of Jarvis's most recent reply
 * in the VoiceRail, but ONLY when the user is inside a Room. On the home
 * thread the reply is already visible in the thread itself, so duplicating
 * here would just be visual noise.
 *
 * The user explicitly asked for last-sentence-only — long replies stay in
 * the thread; this preview is a peek so the user knows Jarvis answered
 * without leaving the Room.
 */
export function RailReplyPreview() {
  const route = useV2Route();
  const { latestAssistantReply } = useLiveData();

  // Hooks must run unconditionally on every render — derive the last
  // sentence first, then gate the JSX. Putting the early returns above
  // the useMemo is a Rules-of-Hooks violation and crashes the tree the
  // first time the gate flips to "in a Room".
  const lastSentence = useMemo(
    () => (latestAssistantReply ? extractLastSentence(latestAssistantReply.text) : ""),
    [latestAssistantReply],
  );

  // Hard gate: only ever render inside a Room.
  if (route.kind !== "room") return null;
  if (!latestAssistantReply || !latestAssistantReply.text.trim()) return null;

  return (
    <div
      className="v2-rail-reply"
      role="status"
      aria-live="polite"
      aria-label="Jarvis just said"
      // Keying on text length triggers the fade-in animation as new
      // tokens stream in; a stable key would skip the animation.
      key={latestAssistantReply.text.length}
    >
      <div className="v2-rail-reply__head">
        <span className="v2-rail-reply__attrib">
          <span className="v2-rail-reply__dot" aria-hidden="true" />
          Jarvis said
        </span>
        {latestAssistantReply.isStreaming && (
          <span className="v2-rail-reply__streaming" aria-hidden="true">
            ●
          </span>
        )}
      </div>
      <div className="v2-rail-reply__text">
        {lastSentence}
        {latestAssistantReply.isStreaming && (
          <span className="v2-rail-reply__caret" aria-hidden="true">
            ▍
          </span>
        )}
      </div>
      <button
        type="button"
        className="v2-rail-reply__link"
        onClick={() => closeRoom()}
      >
        See full reply in thread
        <Icon icon={ArrowRight} size="sm" />
      </button>
    </div>
  );
}

/**
 * Extract the last complete sentence from an assistant reply, capped at
 * MAX_CHARS. We split on `.!?` followed by whitespace; if the reply has
 * no sentence terminator yet (still streaming the first sentence), we
 * just return the whole thing. Trailing whitespace stripped.
 */
function extractLastSentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  // Split into sentences. Keep terminators by capturing.
  const parts = trimmed.split(/(?<=[.!?])\s+/);
  const last = (parts[parts.length - 1] ?? trimmed).trim();
  if (last.length <= MAX_CHARS) return last;
  // Long single sentence — show the head + ellipsis so the user knows
  // there's more in the thread.
  return last.slice(0, MAX_CHARS - 1) + "…";
}

import React from "react";
import { MicOrb, type OrbState } from "./MicOrb";
import { TranscriptBubble } from "../voice/TranscriptBubble";
import { RailConfirmationStack } from "../voice/RailConfirmationStack";
import { RailReplyPreview } from "../voice/RailReplyPreview";
import "./VoiceRail.css";

export type VoiceState =
  | "idle"
  | "listening"
  | "thinking"
  | "speaking"
  | "awaiting-approval"
  | "muted";

const HINT: Record<VoiceState, string> = {
  idle: "Tap the orb, or say “Hey Jarvis.”",
  listening: "Listening. Pause to send.",
  thinking: "Thinking through that…",
  speaking: "Speaking — the reply is in the thread.",
  "awaiting-approval": "Answer in the thread, or say “yes”.",
  muted: "Mic is muted. Tap mute to resume.",
};

const STATUS_LABEL: Record<VoiceState, string> = {
  idle: "Idle",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
  "awaiting-approval": "Awaiting confirmation",
  muted: "Muted",
};

// Phase 7 Pass B — descriptive sentences fed to a screen-reader-only
// `aria-live` region so assistive tech announces every voice-state
// change. Mirrors STATUS_LABEL but as a sentence ending in a period so
// the cadence reads naturally for a TTS narrator like VoiceOver/NVDA.
const STATUS_ANNOUNCEMENT: Record<VoiceState, string> = {
  idle: "Microphone idle.",
  listening: "Listening for your voice.",
  thinking: "Jarvis is thinking.",
  speaking: "Jarvis is speaking.",
  "awaiting-approval": "Awaiting your confirmation.",
  muted: "Microphone muted.",
};

export interface VoiceRailProps {
  state?: VoiceState;
  suggestions?: string[];
  vu?: number;
  device?: string;
  /** Live partial STT shown under the orb. Empty string hides the bubble. */
  partialTranscript?: string;
  onTapOrb?: () => void;
  onSuggestion?: (text: string) => void;
  onToggleMute?: () => void;
}

export function VoiceRail({
  state = "idle",
  suggestions = [],
  vu = 0,
  device = "Default microphone",
  partialTranscript = "",
  onTapOrb,
  onSuggestion,
  onToggleMute,
}: VoiceRailProps) {
  const isLive = state === "listening" || state === "speaking";

  return (
    <aside className="v2-rail" role="region" aria-label="Voice controls">
      {/* Phase 7 Pass B — sr-only live region announces voice state
          changes. Separate from the visual rail (which uses role="region"
          now instead of role="status" so VO doesn't double-announce
          every internal mutation). */}
      <span className="v2-sr-only" role="status" aria-live="polite">
        {STATUS_ANNOUNCEMENT[state]}
      </span>
      <div className="v2-rail__head">
        <span className="v2-rail__label">Voice</span>
        <div className="v2-rail__orb-wrap">
          <MicOrb
            state={state as OrbState}
            size={130}
            onClick={onTapOrb}
            aria-label={`Microphone ${STATUS_LABEL[state]}`}
          />
        </div>
        <StatusChip state={state} />
        <div className="v2-rail__ctrl-row">
          <button
            type="button"
            className="v2-rail__ctrl"
            onClick={onToggleMute}
            data-active={state === "muted"}
          >
            {state === "muted" ? "Muted" : "Mute"}
          </button>
          <span className="v2-rail__ctrl" aria-hidden="true">
            ⌴ Hold
          </span>
        </div>
        {state === "listening" && (
          <TranscriptBubble text={partialTranscript} />
        )}
      </div>

      <div className="v2-rail__hint">
        <div className="v2-rail__hint-text">{HINT[state]}</div>
        <div className="v2-rail__hint-meta">Replies appear in the thread →</div>
      </div>

      {/* Phase 6.5.5 — last sentence of Jarvis's most recent reply,
          only visible inside a Room (component gates itself). Sits above
          the confirmation stack: replies are conversational flow,
          confirmations are actions, both are highest-salience. */}
      <RailReplyPreview />

      {/* Phase 6.3.5b — pending confirmations rendered inline so the
          user can resolve them without leaving any Room. Replaces the
          old "awaiting in the thread →" placeholder; renders nothing
          when no confirmations are pending. */}
      <RailConfirmationStack />

      <div className="v2-rail__spacer" />

      {suggestions.length > 0 && (
        <Suggestions items={suggestions} onPick={onSuggestion} />
      )}

      <MicStatus state={state} vu={vu} device={device} isLive={isLive} />
    </aside>
  );
}

function StatusChip({ state }: { state: VoiceState }) {
  return (
    <span
      className="v2-rail__status-chip"
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-xs)",
        letterSpacing: "0.12em",
        textTransform: "uppercase",
        color: state === "awaiting-approval" ? "var(--warn)" : "var(--ink-2)",
        marginTop: "var(--s-2)",
      }}
    >
      {STATUS_LABEL[state]}
    </span>
  );
}

function Suggestions({
  items,
  onPick,
}: {
  items: string[];
  onPick?: (text: string) => void;
}) {
  return (
    <div className="v2-rail__sugs">
      <div className="v2-rail__sugs-label">Try saying</div>
      <div className="v2-rail__sugs-list">
        {items.map((s, i) => (
          <button
            key={i}
            type="button"
            className="v2-rail__sug"
            onClick={() => onPick?.(s)}
          >
            &ldquo;{s}&rdquo;
          </button>
        ))}
      </div>
    </div>
  );
}

function MicStatus({
  state,
  vu,
  device,
  isLive,
}: {
  state: VoiceState;
  vu: number;
  device: string;
  isLive: boolean;
}) {
  const barCount = 20;
  const activeBars = isLive ? Math.floor(vu * barCount) : 0;

  return (
    <div className="v2-rail__mic">
      <div className="v2-rail__mic-head">
        <span className="v2-rail__mic-label" data-live={isLive}>
          {STATUS_LABEL[state]}
        </span>
      </div>
      <div className="v2-rail__mic-vu" aria-hidden="true">
        {Array.from({ length: barCount }, (_, i) => {
          const active = i < activeBars;
          const hot = active && i > 15;
          return (
            <span
              key={i}
              className="v2-rail__mic-vu-bar"
              data-active={active}
              data-hot={hot}
            />
          );
        })}
      </div>
      <div className="v2-rail__mic-device">{device}</div>
    </div>
  );
}

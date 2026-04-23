import React from "react";
import { MicOrb, type OrbState } from "./MicOrb";
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

export interface VoiceRailProps {
  state?: VoiceState;
  suggestions?: string[];
  vu?: number;
  device?: string;
  onTapOrb?: () => void;
  onSuggestion?: (text: string) => void;
  onToggleMute?: () => void;
}

export function VoiceRail({
  state = "idle",
  suggestions = [],
  vu = 0,
  device = "Default microphone",
  onTapOrb,
  onSuggestion,
  onToggleMute,
}: VoiceRailProps) {
  const isLive = state === "listening" || state === "speaking";

  return (
    <aside className="v2-rail" role="status" aria-label="Voice controls">
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
      </div>

      <div className="v2-rail__hint">
        <div className="v2-rail__hint-text">{HINT[state]}</div>
        <div className="v2-rail__hint-meta">Replies appear in the thread →</div>
      </div>

      {state === "awaiting-approval" && (
        <div className="v2-rail__awaiting" role="status">
          <span className="v2-rail__awaiting-dot" aria-hidden="true" />
          <div>
            <div className="v2-rail__awaiting-title">Awaiting confirmation</div>
            <div className="v2-rail__awaiting-body">Answer in the thread →</div>
          </div>
        </div>
      )}

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

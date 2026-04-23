import React, { useState } from "react";
import { Composer } from "./Composer";
import { Header, type ConnectionState, type Mode } from "./Header";
import { Thread } from "./Thread";
import { VoiceRail, type VoiceState } from "./VoiceRail";
import "./AppShell.css";

const DEMO_SUGGESTIONS_BY_STATE: Record<VoiceState, string[]> = {
  idle: [
    "What's on my calendar today?",
    "Open workflows",
    "Summarize yesterday's logs",
  ],
  listening: [
    "Stop listening",
    "Cancel",
  ],
  thinking: [],
  speaking: [
    "Take me back",
    "Edit the first one",
  ],
  "awaiting-approval": [
    "Yes · approve",
    "Cancel",
    "Explain the risk",
  ],
  muted: [
    "Unmute",
  ],
};

const VOICE_CYCLE: VoiceState[] = [
  "idle",
  "listening",
  "thinking",
  "speaking",
  "awaiting-approval",
  "muted",
];

/**
 * AppShell — Phase 2 skeleton.
 * Header + Thread + VoiceRail + Composer wired with stub state.
 * Click the orb to cycle through voice states for visual QA until Phase 4
 * replaces the stub with live wiring.
 */
export function AppShell() {
  const [mode, setMode] = useState<Mode>("active");
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const connection: ConnectionState = "live";

  const cycleOrb = () => {
    const idx = (VOICE_CYCLE.indexOf(voiceState) + 1) % VOICE_CYCLE.length;
    setVoiceState(VOICE_CYCLE[idx] ?? "idle");
  };

  const toggleMute = () => {
    setVoiceState((s) => (s === "muted" ? "idle" : "muted"));
  };

  return (
    <div className="v2-shell">
      <div className="v2-shell__header">
        <Header
          connection={connection}
          mode={mode}
          onModeChange={setMode}
          onPalette={() => {
            // Phase 5 wires the real palette
          }}
        />
      </div>

      <div className="v2-shell__thread">
        <Thread />
      </div>

      <div className="v2-shell__composer">
        <Composer />
      </div>

      <div className="v2-shell__rail">
        <VoiceRail
          state={voiceState}
          suggestions={DEMO_SUGGESTIONS_BY_STATE[voiceState]}
          vu={voiceState === "listening" ? 0.55 : voiceState === "speaking" ? 0.75 : 0}
          device="Default microphone"
          onTapOrb={cycleOrb}
          onSuggestion={() => undefined}
          onToggleMute={toggleMute}
        />
      </div>
    </div>
  );
}

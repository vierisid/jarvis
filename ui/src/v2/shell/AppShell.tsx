import React, { useCallback, useState } from "react";
import { Composer } from "./Composer";
import { Header, type ConnectionState, type Mode } from "./Header";
import { Thread } from "../thread/Thread";
import { MOCK_THREAD } from "../thread/mock";
import type { ThreadItem } from "../thread/types";
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
type MockVariant<T = ThreadItem> = T extends ThreadItem ? Omit<T, "id" | "t"> : never;

const MOCK_APPEND_VARIANTS: MockVariant[] = [
  {
    kind: "jarvis-speech",
    text: "Heads up — the overnight researcher just pushed a second draft. Want to see it?",
    status: "done",
  },
  {
    kind: "jarvis-thought",
    text: "Rechecking calendar conflicts for the Thursday invite.",
  },
  {
    kind: "user-text",
    text: "Yes, show me the diff.",
  },
  {
    kind: "result",
    summary: "Sidecar heartbeat OK across 2 of 3 hosts.",
    detail: "home-server is still offline — no change in last 14 minutes.",
  },
];

export function AppShell() {
  const [mode, setMode] = useState<Mode>("active");
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [items, setItems] = useState<ThreadItem[]>(MOCK_THREAD);
  const connection: ConnectionState = "live";

  const cycleOrb = () => {
    const idx = (VOICE_CYCLE.indexOf(voiceState) + 1) % VOICE_CYCLE.length;
    setVoiceState(VOICE_CYCLE[idx] ?? "idle");
  };

  const toggleMute = () => {
    setVoiceState((s) => (s === "muted" ? "idle" : "muted"));
  };

  const appendMock = useCallback(() => {
    const variant = MOCK_APPEND_VARIANTS[
      Math.floor(Math.random() * MOCK_APPEND_VARIANTS.length)
    ]!;
    const now = new Date();
    const t = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const id = `dev-${now.getTime()}`;
    setItems((prev) => [...prev, { ...variant, id, t } as ThreadItem]);
  }, []);

  const handleSubmit = useCallback((text: string) => {
    const now = new Date();
    const t = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    setItems((prev) => [
      ...prev,
      { kind: "user-text", id: `u-${now.getTime()}`, text, t },
    ]);
  }, []);

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
        <Thread
          items={items}
          onApprove={(id) => {
            setItems((prev) => prev.filter((i) => i.id !== id));
          }}
          onCancel={(id) => {
            setItems((prev) => prev.filter((i) => i.id !== id));
          }}
          onFocusCard={() => {
            // Phase 6 wires Room navigation
          }}
          dev={{ onAppend: appendMock }}
        />
      </div>

      <div className="v2-shell__composer">
        <Composer onSubmit={handleSubmit} />
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

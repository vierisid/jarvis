import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Composer } from "./Composer";
import { Header, type ConnectionState, type Mode } from "./Header";
import { Thread } from "../thread/Thread";
import { MOCK_THREAD } from "../thread/mock";
import { useLiveThread } from "../thread/useLiveThread";
import type { ThreadItem } from "../thread/types";
import { VoiceRail, type VoiceState } from "./VoiceRail";
import { useVoice } from "../../hooks/useVoice";
import { mapVoiceState } from "../voice/stateMapper";
import { useLLMSuggestions, useSuggestions } from "../voice/useSuggestions";
import "./AppShell.css";

const VOICE_CYCLE: VoiceState[] = [
  "idle",
  "listening",
  "thinking",
  "speaking",
  "awaiting-approval",
  "muted",
];

function isMockMode(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("thread") === "mock";
}

/**
 * AppShell dispatcher.
 *
 * Default path is `<AppShellLive>` — connects to the daemon via WebSocket
 * and renders real ThreadItems from `useLiveThread`. `?thread=mock` mounts
 * `<AppShellMock>` instead, which uses the Phase 3A fixture for visual QA.
 *
 * The split matters because `useWebSocket` opens a real WS connection with
 * reconnect logic; we don't want that running when someone is just reviewing
 * the mock fixture. The same is true for `useVoice` (mic permissions, wake
 * word engine) — only the live path instantiates it.
 */
export function AppShell() {
  const mock = useMemo(isMockMode, []);
  return mock ? <AppShellMock /> : <AppShellLive />;
}

/* ─────────── Live shell — Phase 3B + Phase 4A ─────────── */

function AppShellLive() {
  const live = useLiveThread();
  const voice = useVoice({ wsRef: live.wsRef, wakeWordEnabled: true });

  // Bridge TTS audio + lifecycle from useWebSocket → useVoice (matches the
  // legacy App.tsx pattern). Without this the voice hook never hears about
  // the daemon's `tts_start` / binary chunks / `tts_end` messages.
  useEffect(() => {
    live.voiceCallbacksRef.current = {
      onTTSBinary: voice.handleTTSBinary,
      onTTSStart: voice.handleTTSStart,
      onTTSEnd: voice.handleTTSEnd,
      onError: voice.handleError,
    };
  }, [
    live.voiceCallbacksRef,
    voice.handleTTSBinary,
    voice.handleTTSStart,
    voice.handleTTSEnd,
    voice.handleError,
  ]);

  const awaitingApproval = live.approvals.length > 0;
  const voiceState = mapVoiceState(voice.voiceState, {
    muted: voice.muted,
    awaitingApproval,
    daemonThinking: live.thinking,
  });
  const suggestions = useLLMSuggestions(live.items, { enabled: live.isConnected });

  const handleApprove = useCallback(
    (id: string) => {
      live.approve(id).catch((err) => console.error("[v2] approve failed", err));
    },
    [live],
  );

  const handleCancel = useCallback(
    (id: string) => {
      live.cancel(id).catch((err) => console.error("[v2] cancel failed", err));
    },
    [live],
  );

  const handleClarifier = useCallback(
    (id: string, decision: "confirm" | "cancel") => {
      live
        .resolveClarifier(id, decision)
        .catch((err) => console.error("[v2] clarifier resolve failed", err));
    },
    [live],
  );

  const handleRepeatBack = useCallback(
    (id: string, decision: "confirm" | "cancel") => {
      live
        .resolveRepeatBack(id, decision)
        .catch((err) => console.error("[v2] repeat-back resolve failed", err));
    },
    [live],
  );

  // Tap-orb is a manual record/stop toggle (PTT-style). Wake-word listening
  // continues in the background; both paths produce identical thread items.
  const handleTapOrb = useCallback(() => {
    if (voice.muted) return;
    if (voice.voiceState === "recording") {
      voice.stopRecording();
    } else if (voice.voiceState === "idle") {
      voice.startRecording();
    } else if (voice.voiceState === "speaking") {
      // Tapping the orb during TTS interrupts and starts listening.
      voice.cancelTTS();
      voice.startRecording();
    }
  }, [voice]);

  const handleToggleMute = useCallback(() => {
    voice.setMuted(!voice.muted);
  }, [voice]);

  const handleSuggestion = useCallback(
    (text: string) => {
      // Per the design rule: voice and text share one pipeline.
      // A suggestion click sends the same payload as typing it.
      live.send(text);
    },
    [live],
  );

  return (
    <ShellLayout
      connection={live.isConnected ? "live" : "offline"}
      items={live.items}
      composerDisabled={!live.isConnected}
      composerPlaceholder={
        live.isConnected
          ? "Ask Jarvis, or press / to summon a tool…"
          : "Waiting for daemon…"
      }
      onSubmit={live.send}
      onApprove={handleApprove}
      onCancel={handleCancel}
      onFocusCard={() => undefined}
      onClarifier={handleClarifier}
      onRepeatBack={handleRepeatBack}
      voiceState={voiceState}
      suggestions={suggestions}
      vu={voice.micLevel}
      partialTranscript={voice.partialTranscript}
      onTapOrb={handleTapOrb}
      onSuggestion={handleSuggestion}
      onToggleMute={handleToggleMute}
    />
  );
}

/* ─────────── Mock shell — Phase 3A fixture (no WS, no mic) ─────────── */

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

const MOCK_SUGGESTIONS_BY_STATE: Record<VoiceState, string[]> = {
  idle: ["What's on my calendar today?", "Open workflows", "Summarize yesterday's logs"],
  listening: [],
  thinking: [],
  speaking: ["Take me back", "Edit the first one"],
  "awaiting-approval": [],
  muted: ["Unmute"],
};

function AppShellMock() {
  const [items, setItems] = useState<ThreadItem[]>(MOCK_THREAD);
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");

  const cycleOrb = () => {
    const idx = (VOICE_CYCLE.indexOf(voiceState) + 1) % VOICE_CYCLE.length;
    setVoiceState(VOICE_CYCLE[idx] ?? "idle");
  };

  const toggleMute = () => {
    setVoiceState((s) => (s === "muted" ? "idle" : "muted"));
  };

  const appendMock = useCallback(() => {
    const variant =
      MOCK_APPEND_VARIANTS[Math.floor(Math.random() * MOCK_APPEND_VARIANTS.length)]!;
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
    <ShellLayout
      connection="live"
      items={items}
      onSubmit={handleSubmit}
      onApprove={(id) => setItems((prev) => prev.filter((i) => i.id !== id))}
      onCancel={(id) => setItems((prev) => prev.filter((i) => i.id !== id))}
      onFocusCard={() => undefined}
      devAppend={appendMock}
      voiceState={voiceState}
      suggestions={MOCK_SUGGESTIONS_BY_STATE[voiceState]}
      vu={voiceState === "listening" ? 0.55 : voiceState === "speaking" ? 0.75 : 0}
      partialTranscript={voiceState === "listening" ? "this is a sample partial transcript" : ""}
      onTapOrb={cycleOrb}
      onSuggestion={handleSubmit}
      onToggleMute={toggleMute}
    />
  );
}

/* ─────────── Shared layout ─────────── */

interface ShellLayoutProps {
  connection: ConnectionState;
  items: ThreadItem[];
  composerDisabled?: boolean;
  composerPlaceholder?: string;
  onSubmit: (text: string) => void;
  onApprove: (id: string) => void;
  onCancel: (id: string) => void;
  onFocusCard: (id: string) => void;
  onClarifier?: (id: string, decision: "confirm" | "cancel") => void;
  onRepeatBack?: (id: string, decision: "confirm" | "cancel") => void;
  devAppend?: () => void;
  // Voice
  voiceState: VoiceState;
  suggestions: string[];
  vu: number;
  partialTranscript: string;
  onTapOrb: () => void;
  onSuggestion: (text: string) => void;
  onToggleMute: () => void;
}

function ShellLayout({
  connection,
  items,
  composerDisabled,
  composerPlaceholder,
  onSubmit,
  onApprove,
  onCancel,
  onFocusCard,
  onClarifier,
  onRepeatBack,
  devAppend,
  voiceState,
  suggestions,
  vu,
  partialTranscript,
  onTapOrb,
  onSuggestion,
  onToggleMute,
}: ShellLayoutProps) {
  const [mode, setMode] = useState<Mode>("active");

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
          onApprove={onApprove}
          onCancel={onCancel}
          onFocusCard={onFocusCard}
          onClarifier={onClarifier}
          onRepeatBack={onRepeatBack}
          dev={devAppend ? { onAppend: devAppend } : undefined}
        />
      </div>

      <div className="v2-shell__composer">
        <Composer
          onSubmit={onSubmit}
          disabled={composerDisabled}
          placeholder={composerPlaceholder}
        />
      </div>

      <div className="v2-shell__rail">
        <VoiceRail
          state={voiceState}
          suggestions={suggestions}
          vu={vu}
          device="Default microphone"
          partialTranscript={partialTranscript}
          onTapOrb={onTapOrb}
          onSuggestion={onSuggestion}
          onToggleMute={onToggleMute}
        />
      </div>
    </div>
  );
}

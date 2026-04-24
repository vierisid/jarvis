import React, { useCallback, useMemo, useState } from "react";
import { Composer } from "./Composer";
import { Header, type ConnectionState, type Mode } from "./Header";
import { Thread } from "../thread/Thread";
import { MOCK_THREAD } from "../thread/mock";
import { useLiveThread } from "../thread/useLiveThread";
import type { ThreadItem } from "../thread/types";
import { VoiceRail, type VoiceState } from "./VoiceRail";
import "./AppShell.css";

const DEMO_SUGGESTIONS_BY_STATE: Record<VoiceState, string[]> = {
  idle: [
    "What's on my calendar today?",
    "Open workflows",
    "Summarize yesterday's logs",
  ],
  listening: ["Stop listening", "Cancel"],
  thinking: [],
  speaking: ["Take me back", "Edit the first one"],
  "awaiting-approval": ["Yes · approve", "Cancel", "Explain the risk"],
  muted: ["Unmute"],
};

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
 * the mock fixture.
 */
export function AppShell() {
  const mock = useMemo(isMockMode, []);
  return mock ? <AppShellMock /> : <AppShellLive />;
}

/* ─────────── Live shell — Phase 3B-1 ─────────── */

function AppShellLive() {
  const { items, isConnected, send, approve, cancel } = useLiveThread();
  const connection: ConnectionState = isConnected ? "live" : "offline";

  const handleApprove = useCallback(
    (id: string) => {
      approve(id).catch((err) => {
        console.error("[v2] approve failed", err);
      });
    },
    [approve],
  );

  const handleCancel = useCallback(
    (id: string) => {
      cancel(id).catch((err) => {
        console.error("[v2] cancel failed", err);
      });
    },
    [cancel],
  );

  return (
    <ShellLayout
      connection={connection}
      items={items}
      composerDisabled={!isConnected}
      composerPlaceholder={
        isConnected
          ? "Ask Jarvis, or press / to summon a tool…"
          : "Waiting for daemon…"
      }
      onSubmit={send}
      onApprove={handleApprove}
      onCancel={handleCancel}
      onFocusCard={() => undefined}
    />
  );
}

/* ─────────── Mock shell — Phase 3A fixture ─────────── */

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

function AppShellMock() {
  const [items, setItems] = useState<ThreadItem[]>(MOCK_THREAD);

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
  devAppend?: () => void;
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
  devAppend,
}: ShellLayoutProps) {
  const [mode, setMode] = useState<Mode>("active");
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");

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
        <Thread
          items={items}
          onApprove={onApprove}
          onCancel={onCancel}
          onFocusCard={onFocusCard}
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

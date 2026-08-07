import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Composer } from "./Composer";
import { Header, type ConnectionState } from "./Header";
import { Thread, type ThreadHandle } from "../thread/Thread";
import { MOCK_THREAD } from "../thread/mock";
import { useLiveThread } from "../thread/useLiveThread";
import type { ObjectType, ThreadItem } from "../thread/types";
import { VoiceRail, type VoiceState } from "./VoiceRail";
import { useVoice } from "../../hooks/useVoice";
import { mapVoiceState } from "../voice/stateMapper";
import { useLLMSuggestions, useSuggestions } from "../voice/useSuggestions";
import { CommandPalette } from "../palette/CommandPalette";
import type { PaletteNavEntry, PaletteResult, PaletteResultType } from "../palette/types";
import { navKeyToObjectType } from "../palette/types";
import { usePaletteHotkey } from "../palette/usePaletteHotkey";
import { SystemTakeover, SystemBanners, useSystemStateOverride, type TakeoverKind } from "./SystemStates";
import { BillingBanner } from "../billing/BillingBanner";
import { closeRoom, openRoom, useV2Route, ROOM_KEYS, type RoomKey } from "../router";
import { getRoomBody } from "../rooms/RoomBodyRegistry";
import { setRoomEntry } from "../rooms/roomEntryStore";
import { FloatingWindowsLayer } from "../rooms/FloatingWindowsLayer";
import type { LayoutRect } from "../rooms/useRoomLayout";
import { useSpacebarPTT } from "../voice/useSpacebarPTT";
import { useNotificationCenter } from "../../hooks/useNotificationCenter";
import { NotificationDrawer } from "../notifications/NotificationDrawer";
import { LiveDataProvider } from "./LiveDataContext";
import { PausedTasksBanner } from "./PausedTasksBanner";
import { useRoomActionDispatcher } from "../rooms/useRoomActionBus";
import { IndexSidebar, useIndexCollapsed } from "./IndexSidebar";
import { TopBar } from "./TopBar";
import { NowRoom } from "./NowRoom";
import "./AppShell.css";
import "./roomShell.css";

const PALETTE_TYPE_TO_OBJECT_TYPE: Record<PaletteResultType, ObjectType> = {
  workflow: "workflow",
  memory: "memory",
  tool: "tool",
  agent: "agent",
  authority: "authority",
  log: "log",
};

/** Map an InlineCard objectType to its Room key (most are 1:1, plurals where used). */
function objectTypeToRoomKey(t: ObjectType): RoomKey {
  switch (t) {
    case "workflow":
      return "workflows";
    case "agent":
      return "agents";
    case "log":
      return "logs";
    case "tool":
      return "tools";
    case "memory":
    case "authority":
    case "calendar":
    case "goals":
    case "tasks":
    case "content":
    case "workspaces":
    case "usage":
    case "settings":
      return t;
  }
}

function paletteTypeToRoomKey(t: PaletteResultType): RoomKey {
  return objectTypeToRoomKey(PALETTE_TYPE_TO_OBJECT_TYPE[t]);
}

function isRoomKey(k: string): k is RoomKey {
  return ROOM_KEYS.has(k as RoomKey); // router's canonical set — no drifting copy
}

/** Debounced offline: a reconnect blip (or the pre-connect mount state) never
 *  flashes the takeover, but genuine outages still surface. Once-connected
 *  sessions get a short grace; a session whose WS NEVER connects (daemon
 *  serving static UI with a dead handshake) gets a longer one — suppressing
 *  that case forever would hide the recovery screen exactly when it's needed. */
function useStableOffline(offline: boolean, graceMs = 5000, neverConnectedGraceMs = 15000): boolean {
  const [stable, setStable] = useState(false);
  const everConnectedRef = useRef(false);
  useEffect(() => {
    if (!offline) {
      everConnectedRef.current = true;
      setStable(false);
      return;
    }
    const t = window.setTimeout(() => setStable(true), everConnectedRef.current ? graceMs : neverConnectedGraceMs);
    return () => window.clearTimeout(t);
  }, [offline, graceMs, neverConnectedGraceMs]);
  return stable;
}

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
  // Phase 6.7.C — feed the voice hook a getter that reads the current
  // Room from the URL hash on each utterance. Stable identity (no
  // closure on rendered state) so useVoice's `sendAudioToServer`
  // useCallback doesn't churn. Falls through to "home" for the thread.
  const getCurrentRoom = useCallback((): string => {
    if (typeof window === "undefined") return "home";
    const m = window.location.hash.match(/^#\/?_room_([a-z]+)/);
    return m ? m[1]! : "home";
  }, []);
  const voice = useVoice({
    wsRef: live.wsRef,
    wakeWordEnabled: true,
    getCurrentRoom,
  });

  // Bridge TTS audio + lifecycle from useWebSocket → useVoice (matches the
  // legacy App.tsx pattern). Without this the voice hook never hears about
  // the daemon's `tts_start` / binary chunks / `tts_end` messages.
  useEffect(() => {
    live.voiceCallbacksRef.current = {
      onTTSBinary: voice.handleTTSBinary,
      onTTSStart: voice.handleTTSStart,
      onTTSContainsWake: voice.handleTTSContainsWake,
      onTTSEnd: voice.handleTTSEnd,
      onError: voice.handleError,
      onRealtimeClosed: voice.handleRealtimeClosed,
    };
  }, [
    live.voiceCallbacksRef,
    voice.handleTTSBinary,
    voice.handleTTSStart,
    voice.handleTTSContainsWake,
    voice.handleTTSEnd,
    voice.handleError,
    voice.handleRealtimeClosed,
  ]);

  // Daemon-driven navigation (voice "open workflows" → navigate_room,
  // "back to the thread" → navigate_home). Phase 6.1.5: opening goes to
  // an inline RoomWindow in the thread (not the overlay); "back" closes
  // the overlay if it's open, otherwise closes the most-recent inline
  // window. `voice.forceIdle()` so the orb leaves processing immediately
  // (chat path is bypassed → no tts_start to clear it via TTS lifecycle).
  const navKey = live.roomNavRequest?.key;
  const navTs = live.roomNavRequest?.ts;
  useEffect(() => {
    if (typeof navKey !== "string") return;
    if (navKey === "home") {
      // Prefer closing the overlay if any Room is currently expanded;
      // else close the most-recent inline window.
      if (window.location.hash.startsWith("#/_room_")) {
        closeRoom();
      } else {
        live.closeMostRecentRoomWindow();
      }
    } else if (isRoomKey(navKey)) {
      // Room → Room (Phase 6.8): if a fullscreen Room overlay is currently
      // open, swap the URL hash to the new room so the overlay swaps in
      // place — otherwise the new room would mount as an inline window
      // *underneath* the existing overlay and the user would see nothing
      // change. Also keeps the queued room_action behavior intact: when
      // the new room's body mounts via the swap, its `useRoomActions`
      // registers and the bus drains any queued action targeting it.
      // From the home thread, behaviour is unchanged: open inline.
      setRoomEntry(navKey, "voice");
      if (window.location.hash.startsWith("#/_room_")) {
        openRoom(navKey);
      } else {
        live.openRoomWindow(navKey);
      }
    } else {
      console.warn("[v2] navigate request with unknown key:", navKey);
      return;
    }
    voice.forceIdle();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navKey, navTs]);

  // Daemon-driven RoomWindow chrome control (voice "close" / "minimize"
  // / "expand" / "restore"). Resolves "most_recent" to the most-recently-
  // added window in the items list; named targets to the matching window.
  const wcAction = live.windowControlRequest?.action;
  const wcTarget = live.windowControlRequest?.target;
  const wcTs = live.windowControlRequest?.ts;
  useEffect(() => {
    if (!wcAction || !wcTarget) return;

    // Find the room-window we should operate on.
    const windows = live.items.filter(
      (i): i is Extract<ThreadItem, { kind: "room-window" }> => i.kind === "room-window",
    );

    let target: Extract<ThreadItem, { kind: "room-window" }> | undefined;
    if (wcTarget === "most_recent") {
      target = windows[windows.length - 1];
    } else if (isRoomKey(wcTarget)) {
      // Most-recent matching key (in case the same room was opened twice).
      for (let i = windows.length - 1; i >= 0; i--) {
        if (windows[i]!.roomKey === wcTarget) {
          target = windows[i];
          break;
        }
      }
    }

    if (!target) {
      // No matching window. For "expand" we can still open the room
      // overlay directly (graceful degradation: user said "expand tools"
      // but no inline tools window exists → just open the overlay).
      if (wcAction === "expand" && wcTarget !== "most_recent" && isRoomKey(wcTarget)) {
        setRoomEntry(wcTarget, "voice");
        openRoom(wcTarget);
      }
      voice.forceIdle();
      return;
    }

    switch (wcAction) {
      case "close":
        live.closeRoomWindow(target.id);
        break;
      case "minimize":
        live.setRoomWindowStateById(target.id, "minimized");
        break;
      case "restore":
        live.setRoomWindowStateById(target.id, "inline");
        break;
      case "expand":
        setRoomEntry(target.roomKey as RoomKey, "voice");
        openRoom(target.roomKey as RoomKey);
        break;
      case "reorder":
        // handled below via the global path; shouldn't reach here with target
        break;
    }
    voice.forceIdle();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wcAction, wcTarget, wcTs]);

  // Reorder is global: bring all floating windows back to inline. Runs in
  // a separate effect so it doesn't depend on a target window existing.
  useEffect(() => {
    if (wcAction !== "reorder") return;
    live.reorderAllToInline();
    voice.forceIdle();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wcAction, wcTs]);

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
  // From any "busy" state (speaking/processing/wake_detected), tapping
  // interrupts the in-flight turn and starts a fresh recording — the user
  // shouldn't have to wait for Jarvis to finish thinking to talk over it.
  const handleTapOrb = useCallback(() => {
    if (voice.muted) return;
    if (voice.voiceState === "recording") {
      voice.stopRecording();
    } else if (voice.voiceState === "idle") {
      voice.startRecording();
    } else if (voice.voiceState === "speaking") {
      voice.cancelTTS();
      voice.startRecording();
    } else if (voice.voiceState === "processing" || voice.voiceState === "wake_detected") {
      // No TTS yet — just snap back to idle and re-arm.
      voice.forceIdle();
      voice.startRecording();
    }
  }, [voice]);

  // Universal interrupt: wherever we are, drop everything and go to idle.
  // Used by the spacebar PTT hook so a held Space always starts fresh.
  const interruptAndArm = useCallback(() => {
    if (voice.voiceState === "speaking") voice.cancelTTS();
    else voice.forceIdle();
    voice.startRecording();
  }, [voice]);

  // Global push-to-talk: hold Space (outside text fields) to record.
  useSpacebarPTT({
    enabled: !voice.muted && live.isConnected,
    voiceState: voice.voiceState,
    startRecording: voice.startRecording,
    stopRecording: voice.stopRecording,
    interrupt: interruptAndArm,
  });

  const handleToggleMute = useCallback(() => {
    voice.setMuted(!voice.muted);
  }, [voice]);

  const handleSuggestion = useCallback(
    (text: string) => {
      // Per the design rule: voice and text share one pipeline.
      // A suggestion click sends the same payload as typing it.
      if (voice.voiceState === "speaking") voice.cancelTTS();
      live.send(text);
    },
    [live, voice],
  );

  const stopCurrentResponse = useCallback(() => {
    live.stopResponse();
    voice.cancelTTS();
    voice.forceIdle();
  }, [live, voice]);

  const handleChatSubmit = useCallback((text: string) => {
    if (voice.voiceState === "speaking") voice.cancelTTS();
    live.send(text, { currentRoom: getCurrentRoom() });
  }, [getCurrentRoom, live, voice]);

  // ── Palette wiring (Phase 5A) ──
  const [paletteOpen, setPaletteOpen] = useState(false);
  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);
  usePaletteHotkey(openPalette);

  // ── Notification center (Phase 6.2-A) ──
  const threadRef = useRef<ThreadHandle | null>(null);
  const notif = useNotificationCenter({
    approvals: live.approvals,
    clarifiers: live.clarifiers,
    repeatBacks: live.repeatBacks,
    notices: live.notices,
  });
  const [notifOpen, setNotifOpen] = useState(false);
  const toggleNotif = useCallback(() => setNotifOpen((v) => !v), []);
  const closeNotif = useCallback(() => setNotifOpen(false), []);

  // ⌥N (Alt+N) toggles the drawer. Skipped while typing in editable fields
  // so it doesn't hijack keyboard input in the composer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.metaKey || e.ctrlKey) return;
      if (e.key.toLowerCase() !== "n") return;
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable) return;
      }
      e.preventDefault();
      setNotifOpen((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Picking a notification: mark read, close the drawer, close any open
  // Room overlay so the thread is visible, then scroll the matching item
  // into view. Approvals/clarifiers/repeat-backs always have a thread item
  // with the same id; system notices don't (no scroll target — the row
  // simply marks read and dismisses).
  const handleNotifPick = useCallback(
    (id: string) => {
      notif.markRead(id);
      closeNotif();
      if (window.location.hash.startsWith("#/_room_")) {
        closeRoom();
      }
      // Defer one frame so the Room overlay (if any) has unmounted before
      // we measure the scroll target.
      window.requestAnimationFrame(() => {
        threadRef.current?.scrollToItem(id);
      });
    },
    [notif, closeNotif],
  );

  const handlePickObject = useCallback(
    (result: PaletteResult, openInRoom: boolean) => {
      if (openInRoom) {
        // Phase 6.0: Shift+Enter opens the matching Room directly as the
        // fullscreen overlay (skipping the inline window). For object
        // results this means jumping straight into the Room where the
        // object lives.
        const targetRoom = paletteTypeToRoomKey(result.type);
        setRoomEntry(targetRoom, "palette", result.title);
        openRoom(targetRoom);
        return;
      }
      live.injectCard({
        objectType: PALETTE_TYPE_TO_OBJECT_TYPE[result.type],
        ref: result.ref,
        title: result.title,
        summary: result.summary,
        meta: result.meta,
        status: result.status,
      });
    },
    [live],
  );

  // Phase 6.1.5: picking a Room from the palette opens it as an inline
  // RoomWindow at the bottom of the thread (the room-window IS the preview).
  // Shift+Enter still opens the fullscreen overlay directly.
  const handlePickRoom = useCallback(
    (entry: PaletteNavEntry, openInRoom: boolean) => {
      if (openInRoom) {
        setRoomEntry(entry.key as RoomKey, "palette");
        openRoom(entry.key as RoomKey);
        return;
      }
      // From inside a fullscreen Room, picking another Room from the
      // palette should swap the overlay rather than opening a hidden
      // inline window underneath. Phase 6.8 Room → Room polish.
      if (window.location.hash.startsWith("#/_room_")) {
        setRoomEntry(entry.key as RoomKey, "palette");
        openRoom(entry.key as RoomKey);
        return;
      }
      live.openRoomWindow(entry.key as RoomKey);
    },
    [live],
  );

  // Phase 6.5.5 — derive the latest assistant reply from the live thread
  // items so the rail's RailReplyPreview can show it without leaving the
  // Room. We walk from the end since it's the most-recent — `useLiveThread`
  // already sorts items chronologically.
  const latestAssistantReply = useMemo(() => {
    for (let i = live.items.length - 1; i >= 0; i--) {
      const item = live.items[i]!;
      if (item.kind === "jarvis-speech" && item.text) {
        return {
          text: item.text,
          isStreaming: item.status === "speaking",
          ts: Date.now(), // updated on each render-with-new-text → fade-in animation key
        };
      }
    }
    return null;
  }, [live.items]);

  return (
    <LiveDataProvider
      value={{
        approvals: live.approvals,
        clarifiers: live.clarifiers,
        repeatBacks: live.repeatBacks,
        notices: live.notices,
        taskEvents: live.taskEvents,
        contentEvents: live.contentEvents,
        agentActivity: live.agentActivity,
        settingsEvents: live.settingsEvents,
        latestAssistantReply,
      }}
    >
      <RoomActionBridge request={live.roomActionRequest} forceIdle={voice.forceIdle} />
      <ShellLayout
        connection={live.isConnected ? "live" : "offline"}
        items={live.items}
        threadRef={threadRef}
        composerDisabled={!live.isConnected}
        composerPlaceholder={
          live.isConnected
            ? "Ask Jarvis, or press / to summon a tool…"
            : "Waiting for daemon…"
        }
        composerResponding={live.isResponding || live.thinking || voice.voiceState === "speaking"}
        onStopResponse={stopCurrentResponse}
        onSubmit={handleChatSubmit}
        onApprove={handleApprove}
        onCancel={handleCancel}
        onFocusCard={(id) => {
          const item = live.items.find((i) => i.id === id);
          if (item && item.kind === "card") {
            // Phase 6.1.5: Focus on an object InlineCard opens that Room
            // as an inline RoomWindow (consistent with palette Room picks).
            live.openRoomWindow(objectTypeToRoomKey(item.objectType));
          }
        }}
        onRoomClose={(id) => live.closeRoomWindow(id)}
        onRoomMinimize={(id) => live.setRoomWindowStateById(id, "minimized")}
        onRoomRestore={(id) => live.setRoomWindowStateById(id, "inline")}
        onRoomExpand={(id) => {
          const item = live.items.find((i) => i.id === id);
          if (item && item.kind === "room-window") {
            // Inline windows in the thread were spawned by some prior
            // action (palette pick, voice "open X", or InlineCard
            // Focus). We don't track that origin per-window today, so
            // mark the expand as "thread" — the user is escalating an
            // existing thread element to fullscreen.
            setRoomEntry(item.roomKey as RoomKey, "thread");
            openRoom(item.roomKey as RoomKey);
          }
        }}
        onRoomLayoutChange={(id, next) => live.setRoomWindowLayout(id, next)}
        onClarifier={handleClarifier}
        onRepeatBack={handleRepeatBack}
        voiceState={voiceState}
        suggestions={suggestions}
        vu={voice.micLevel}
        partialTranscript={voice.partialTranscript}
        onTapOrb={handleTapOrb}
        onSuggestion={handleSuggestion}
        onToggleMute={handleToggleMute}
        onOpenPalette={openPalette}
        notificationCount={notif.unreadCount}
        notificationsOpen={notifOpen}
        onToggleNotifications={toggleNotif}
        notificationsSlot={
          <NotificationDrawer
            open={notifOpen}
            items={notif.items}
            onClose={closeNotif}
            onMarkAllRead={notif.markAllRead}
            onPick={handleNotifPick}
          />
        }
      />
      <FloatingWindowsLayer
        windows={live.roomWindows}
        onClose={(id) => live.closeRoomWindow(id)}
        onMinimize={(id) => live.setRoomWindowStateById(id, "minimized")}
        onRestore={(id) => live.setRoomWindowStateById(id, "inline")}
        onExpand={(id) => {
          const item = live.items.find((i) => i.id === id);
          if (item && item.kind === "room-window") {
            // Floating-window expand → fullscreen room. Same source
            // attribution as the inline expand above.
            setRoomEntry(item.roomKey as RoomKey, "thread");
            openRoom(item.roomKey as RoomKey);
          }
        }}
        onLayoutChange={(id, next) => live.setRoomWindowLayout(id, next)}
      />
      <CommandPalette
        open={paletteOpen}
        enabled={live.isConnected}
        onClose={closePalette}
        onPickObject={handlePickObject}
        onPickRoom={handlePickRoom}
      />
    </LiveDataProvider>
  );
}

/**
 * Tiny bridge: lives inside RoomActionBusProvider, reads the dispatcher,
 * and fires it whenever a new `roomActionRequest` arrives from the WS.
 * Also force-idles the voice orb (the Room handles the action itself, no
 * tts_start ever fires to clear `processing`).
 */
function RoomActionBridge({
  request,
  forceIdle,
}: {
  request: { room: string; action: string; args: Record<string, unknown>; ts: number } | null;
  forceIdle: () => void;
}) {
  const { dispatch } = useRoomActionDispatcher();
  const ts = request?.ts;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!request) return;
    dispatch(request);
    forceIdle();
  }, [ts]);
  return null;
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
  const [paletteOpen, setPaletteOpen] = useState(false);
  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);
  usePaletteHotkey(openPalette);

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

  // Mock palette: hand-rolled fixture so visual QA works without a daemon
  const handlePickObject = useCallback((result: PaletteResult) => {
    const now = new Date();
    const t = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    setItems((prev) => [
      ...prev,
      {
        kind: "card",
        id: `palette-mock-${now.getTime()}`,
        objectType: PALETTE_TYPE_TO_OBJECT_TYPE[result.type],
        ref: result.ref,
        title: result.title,
        summary: result.summary,
        meta: result.meta,
        status: result.status,
        t,
      } as ThreadItem,
    ]);
  }, []);

  return (
    <>
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
        onOpenPalette={openPalette}
      />
      <CommandPalette
        open={paletteOpen}
        enabled={false}
        onClose={closePalette}
        onPickObject={handlePickObject}
        onPickRoom={(entry, openInRoom) => {
          if (openInRoom) {
            openRoom(entry.key as RoomKey);
            return;
          }
          // Mock parity with Live: inject a Room-preview card.
          const now = new Date();
          const t = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
          setItems((prev) => [
            ...prev,
            {
              kind: "card",
              id: `palette-room-${now.getTime()}`,
              objectType: navKeyToObjectType(entry.key) as ObjectType,
              ref: `room:${entry.key}`,
              title: entry.label,
              summary: entry.hint,
              meta: "Room",
              t,
            } as ThreadItem,
          ]);
        }}
      />
    </>
  );
}

/* ─────────── Shared layout ─────────── */

interface ShellLayoutProps {
  connection: ConnectionState;
  items: ThreadItem[];
  threadRef?: React.MutableRefObject<ThreadHandle | null>;
  composerDisabled?: boolean;
  composerPlaceholder?: string;
  composerResponding?: boolean;
  onStopResponse?: () => void;
  onSubmit: (text: string) => void;
  onApprove: (id: string) => void;
  onCancel: (id: string) => void;
  onFocusCard: (id: string) => void;
  onClarifier?: (id: string, decision: "confirm" | "cancel") => void;
  onRepeatBack?: (id: string, decision: "confirm" | "cancel") => void;
  // Phase 6.1.5 / 6.1.6 — RoomWindow controls
  onRoomClose?: (id: string) => void;
  onRoomMinimize?: (id: string) => void;
  onRoomRestore?: (id: string) => void;
  onRoomExpand?: (id: string) => void;
  onRoomLayoutChange?: (id: string, next: { mode: "inline" } | { mode: "floating"; rect: LayoutRect }) => void;
  devAppend?: () => void;
  // Voice
  voiceState: VoiceState;
  suggestions: string[];
  vu: number;
  partialTranscript: string;
  onTapOrb: () => void;
  onSuggestion: (text: string) => void;
  onToggleMute: () => void;
  // Palette (Phase 5A)
  onOpenPalette: () => void;
  // Phase 6.2-A — Notification center (live shell only; mock omits)
  notificationCount?: number;
  notificationsOpen?: boolean;
  onToggleNotifications?: () => void;
  notificationsSlot?: React.ReactNode;
}

/** Render the active room's body (expanded) inside the shell surface. */
function RoomSurface({ roomKey }: { roomKey: RoomKey }) {
  const Body = getRoomBody(roomKey);
  return <Body mode="expanded" />;
}

/** Live-state microcopy on the Talk hint line — the old rail's lines, verbatim. */
const TALK_HINT: Record<VoiceState, string> = {
  idle: "Tap the pebble, or say “Hey Jarvis.”",
  listening: "Listening. Pause to send.",
  thinking: "Thinking through that…",
  speaking: "Speaking — the reply is in the thread.",
  "awaiting-approval": "Answer here, or say “yes.”",
  muted: "Mic is muted. Tap mute to resume.",
};

function ShellLayout({
  connection,
  items,
  threadRef,
  composerDisabled,
  composerPlaceholder,
  composerResponding,
  onStopResponse,
  onSubmit,
  onApprove,
  onCancel,
  onFocusCard,
  onClarifier,
  onRepeatBack,
  onRoomClose,
  onRoomMinimize,
  onRoomRestore,
  onRoomExpand,
  onRoomLayoutChange,
  devAppend,
  voiceState,
  suggestions,
  vu,
  partialTranscript,
  onTapOrb,
  onSuggestion,
  onToggleMute,
  onOpenPalette,
  notificationCount,
  notificationsOpen,
  onToggleNotifications,
  notificationsSlot,
}: ShellLayoutProps) {
  const route = useV2Route();
  const [collapsed, toggleCollapse] = useIndexCollapsed();
  const [arranging, setArranging] = useState(false);
  const [talkOpen, setTalkOpen] = useState(false);
  const [talkIn, setTalkIn] = useState(false);

  // awaiting-approval renders as the "asking" (amber) pebble state.
  const dataState = voiceState === "awaiting-approval" ? "asking" : voiceState;

  // ⌘J summons/dismisses Talk; Esc dismisses it. No editable-field gate: the
  // chord never inserts text, and Esc must work from inputs inside Talk.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "j" || e.key === "J")) {
        e.preventDefault();
        setTalkOpen((o) => !o);
      } else if (e.key === "Escape" && talkOpen) {
        setTalkOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [talkOpen]);

  // Drop-to-glass enter animation (two RAFs so the transition catches).
  useEffect(() => {
    if (!talkOpen) { setTalkIn(false); return; }
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => { raf2 = requestAnimationFrame(() => setTalkIn(true)); });
    return () => { cancelAnimationFrame(raf1); cancelAnimationFrame(raf2); };
  }, [talkOpen]);

  // System states. Offline is wired to the real connection; the rest (updating,
  // crash, out-of-tokens, and both banners) are previewable via the override
  // until their backend triggers (update feed, crash capture, quota) land.
  // The full-screen takeover only fires once a previously-established
  // connection has been down for a few seconds — a WS blip (or the initial
  // pre-connect state on mount) must not flash a takeover.
  const sysOverride = useSystemStateOverride();
  const offlineStable = useStableOffline(connection === "offline");
  const takeover: TakeoverKind | null = offlineStable ? "offline" : sysOverride.takeover;
  const sysHandlers = useMemo(
    () => ({
      onRetry: () => window.dispatchEvent(new Event("jarvis:ws-reconnect")),
      onCheckStatus: () => window.open("https://status.usejarvis.com", "_blank", "noopener"),
      onReopen: () => window.location.reload(),
      onSendReport: () => window.open("https://usejarvis.com/support", "_blank", "noopener"),
      onUpgrade: () => window.open("https://usejarvis.com/pricing", "_blank", "noopener"),
      onTopUp: () => window.open("https://usejarvis.com/pricing", "_blank", "noopener"),
      onSwitchLocal: () => { window.location.hash = "#/_room_settings"; },
    }),
    [],
  );

  return (
    <div className={`rshell${collapsed ? " slim" : ""}`} data-state={dataState}>
      <IndexSidebar collapsed={collapsed} onToggleCollapse={toggleCollapse} />

      <TopBar
        connection={connection}
        voiceState={voiceState}
        arranging={arranging}
        onArrange={() => setArranging((a) => !a)}
        onOpenPalette={onOpenPalette}
        notificationCount={notificationCount}
        notificationsOpen={notificationsOpen}
        onToggleNotifications={onToggleNotifications}
      />

      {/* Surface — the active room owns it; the conversation is summoned.
          Render the room BODY (mode="expanded") directly, not the RoomShell-
          wrapped overlay, so the room sheds its own header/back chrome and
          inherits the Index + top bar around it. */}
      <div className="rs-main">
        {/* Banners over a usable app — sit under the top bar, push content down. */}
        <SystemBanners
          update={sysOverride.banners.includes("update")}
          providerBusy={sysOverride.banners.includes("rate")}
        />
        {/* Subscription state banner (trial / past-due / canceling / expired). */}
        <BillingBanner />
        {route.kind === "room" ? (
          <div className="rs-surface rs-room">
            <RoomSurface roomKey={route.key} />
          </div>
        ) : (
          <NowRoom connection={connection} arranging={arranging} onApprove={onApprove} onCancel={onCancel} />
        )}
      </div>

      {/* Docked pebble — opens/closes Talk. It does NOT start voice; the
          mic only engages from the pebble inside the Talk panel (or PTT). */}
      <button
        className="rs-peb"
        aria-label={talkOpen ? "Close Talk" : "Open Talk"}
        aria-expanded={talkOpen}
        onClick={() => setTalkOpen((o) => !o)}
      >
        <span className="gdrop live"><span className="in" /><span className="ring" /></span>
        <span className="rs-stl">{dataState}</span>
      </button>

      {/* Talk — everything the VoiceRail + thread + composer did, summoned. */}
      {talkOpen && (
        <div className={`rs-talk${talkIn ? " in" : ""}`} role="dialog" aria-label="Talk to Jarvis">
          <div className="th">
            <button
              className="rs-talk-mic"
              onClick={onTapOrb}
              aria-label={voiceState === "idle" || voiceState === "muted" ? "Start talking" : "Stop"}
              aria-pressed={voiceState !== "idle" && voiceState !== "muted"}
              title="Tap to talk"
            >
              <span className="gdrop live"><span className="in" /><span className="ring" /></span>
            </button>
            <div className="rs-talk-title">
              <span className="tt">Talk</span>
              <span className="rs-talk-sub">
                {voiceState === "idle" ? "tap the pebble to talk" : TALK_HINT[voiceState]}
              </span>
            </div>
            <button className="esc" onClick={() => setTalkOpen(false)} aria-label="Close Talk">⌘J · esc</button>
          </div>

          <div className="rs-talk-thread">
            <PausedTasksBanner />
            <Thread
              ref={threadRef}
              items={items}
              onApprove={onApprove}
              onCancel={onCancel}
              onFocusCard={onFocusCard}
              onClarifier={onClarifier}
              onRepeatBack={onRepeatBack}
              onRoomClose={onRoomClose}
              onRoomMinimize={onRoomMinimize}
              onRoomRestore={onRoomRestore}
              onRoomExpand={onRoomExpand}
              onRoomLayoutChange={onRoomLayoutChange}
              dev={devAppend ? { onAppend: devAppend } : undefined}
            />
          </div>

          {partialTranscript && (
            <div style={{ padding: "0 14px 8px", fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--ink3)" }}>
              {partialTranscript}…
            </div>
          )}

          {suggestions.length > 0 && (
            <div style={{ padding: "0 14px 10px", display: "flex", flexWrap: "wrap", gap: 6 }}>
              {suggestions.slice(0, 3).map((s) => (
                <button
                  key={s}
                  onClick={() => onSuggestion(s)}
                  style={{ fontSize: 11, color: "var(--ink2)", border: "1px solid var(--rule)", borderRadius: 999, padding: "5px 11px", background: "var(--raise)", cursor: "pointer", fontFamily: "var(--sans)" }}
                >
                  {s}
                </button>
              ))}
            </div>
          )}

          <div className="rs-talk-foot">
            <div style={{ padding: "11px 13px" }}>
              <Composer
                onSubmit={onSubmit}
                onSlash={onOpenPalette}
                disabled={composerDisabled}
                responding={composerResponding}
                onStop={onStopResponse}
                placeholder={composerPlaceholder}
              />
            </div>
          </div>
        </div>
      )}

      {notificationsSlot}

      {/* Full-window takeover — offline is live (fades back to the app on
          reconnect); updating/crash/out-of-tokens preview via the override. */}
      <SystemTakeover kind={takeover} handlers={sysHandlers} />
    </div>
  );
}

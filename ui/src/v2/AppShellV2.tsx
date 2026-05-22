import React, { useEffect } from "react";
import { useV2Route } from "./router";
import { AppShell } from "./shell/AppShell";
import { PrimitivesPage } from "./pages/PrimitivesPage";
import { RoomDispatcher } from "./rooms/RoomDispatcher";
import { RoomActionBusProvider, useRoomActionDispatcher } from "./rooms/useRoomActionBus";
import { getRoomBody } from "./rooms/RoomBodyRegistry";
import { maybeRunUrlReset } from "./onboarding/resetClient";
import { OnboardingGate } from "./onboarding/OnboardingGate";
import { PalettePage } from "./pages/PalettePage";
import { TaskResultRoom } from "./rooms/taskResult/TaskResultRoom";
import { AnswerRoom } from "./rooms/answer/AnswerRoom";
import "./v2.css";
import "./ui/primitives.css";

/**
 * v2 root. Always renders the AppShell (so the thread is preserved across
 * Room navigation) plus an optional Room overlay or primitives showcase
 * on top, keyed off the route.
 *
 * Phase 6.3.5 — RoomActionBusProvider must wrap BOTH the AppShell (which
 * mounts inline RoomWindow bodies) AND the RoomDispatcher (which mounts
 * the expanded Room overlay). They're siblings here, so the bus has to
 * live above them — not inside AppShell.
 *
 * Onboarding reset gate (Phase A): on first mount, check the URL for
 * `?onboarding=reset[&scope=...]` — if present, fire the reset endpoint,
 * clear the localStorage caches the daemon names, then reload. Strips
 * the param either way so we don't loop. The handler is a one-shot at
 * mount; any user-initiated reset (settings button, voice command)
 * goes through the same `resetOnboarding()` helper.
 */
export function AppShellV2() {
  const route = useV2Route();

  useEffect(() => {
    maybeRunUrlReset().catch(() => {
      /* helper logs and strips the param on failure */
    });
  }, []);

  // Panel mode: the sidecar spawned this dashboard URL as a standalone
  // native window (T18). Render JUST the room body — no AppShell, no
  // Thread/Rail/Composer chrome, no voice handlers — so the pebble's
  // sidecar-side voice loop stays the only voice surface. The
  // PanelRoomActionBridge wires this panel's RoomActionBus to the
  // daemon's WS so voice-driven actions ("switch to editor tab") can
  // reach the room's handler — the same path AppShell uses, minus the
  // chrome.
  if (route.kind === "panel") {
    const Body = getRoomBody(route.key);
    return (
      <div className="jarvis-v2-root jarvis-v2-panel-mode">
        <RoomActionBusProvider>
          <PanelRoomActionBridge />
          <Body mode="expanded" />
        </RoomActionBusProvider>
      </div>
    );
  }

  // Task-result mode: spawned by the sub-pebble's "open full" button so
  // the user can read a long sub-agent response. Standalone — no AppShell,
  // no voice handlers, just the result body. Reads the task id from the
  // hash.
  if (route.kind === "task") {
    return (
      <div className="jarvis-v2-root jarvis-v2-task-mode">
        <TaskResultRoom taskId={route.id} />
      </div>
    );
  }

  // Answer-overflow mode: spawned when the user clicks "open full ↗" on
  // the pebble speaking bubble. Renders the full LLM response as markdown
  // so long answers stay readable without TTS.
  if (route.kind === "answer") {
    return (
      <div className="jarvis-v2-root jarvis-v2-task-mode">
        <AnswerRoom answerId={route.id} />
      </div>
    );
  }

  // Palette mode: cursor-anchored fuzzy room picker spawned by the
  // sidecar's Ctrl+K hotkey (W4). Renders a minimal, framed palette page
  // with no AppShell chrome.
  if (route.kind === "palette") {
    return (
      <div className="jarvis-v2-root jarvis-v2-palette-mode">
        <PalettePage />
      </div>
    );
  }

  return (
    <div className="jarvis-v2-root">
      {/* Panel mode body sits above this guard. */}
      {route.kind === "primitives" ? (
        <PrimitivesPage />
      ) : (
        <OnboardingGate>
          <RoomActionBusProvider>
            <AppShell />
            {route.kind === "room" && <RoomDispatcher roomKey={route.key} />}
          </RoomActionBusProvider>
        </OnboardingGate>
      )}
    </div>
  );
}

/**
 * T20c — Panel-mode WS bridge. Opens a WebSocket to the daemon and
 * forwards every `room_action` notification into the panel's
 * RoomActionBus, so voice commands like "switch to the editor tab"
 * reach the room's `useRoomActions` handler the same way they do in
 * the full dashboard. Only mounted inside the panel-mode branch above,
 * so the regular dashboard's WS plumbing isn't doubled up.
 */
function PanelRoomActionBridge() {
  const { dispatch } = useRoomActionDispatcher();
  useEffect(() => {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${window.location.host}/ws`;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const connect = () => {
      ws = new WebSocket(url);
      ws.addEventListener("message", (e) => {
        let msg: unknown;
        try { msg = JSON.parse(typeof e.data === "string" ? e.data : ""); }
        catch { return; }
        if (!msg || typeof msg !== "object") return;
        const m = msg as { type?: string; payload?: { source?: string; room?: string; action?: string; args?: Record<string, unknown> } };
        if (m.type !== "notification" || m.payload?.source !== "room_action") return;
        if (!m.payload.room || !m.payload.action) return;
        dispatch({
          room: m.payload.room,
          action: m.payload.action,
          args: m.payload.args ?? {},
          ts: Date.now(),
        });
      });
      ws.addEventListener("close", () => {
        if (closed) return;
        // Auto-reconnect with a small backoff so the panel keeps
        // listening after a daemon restart.
        reconnectTimer = setTimeout(connect, 1500);
      });
      ws.addEventListener("error", () => { /* let close handle reconnect */ });
    };

    connect();

    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, [dispatch]);
  return null;
}

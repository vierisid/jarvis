import React, { useEffect } from "react";
import { useV2Route } from "./router";
import { AppShell } from "./shell/AppShell";
import { PrimitivesPage } from "./pages/PrimitivesPage";
import { RoomDispatcher } from "./rooms/RoomDispatcher";
import { RoomActionBusProvider } from "./rooms/useRoomActionBus";
import { getRoomBody } from "./rooms/RoomBodyRegistry";
import { maybeRunUrlReset } from "./onboarding/resetClient";
import { OnboardingGate } from "./onboarding/OnboardingGate";
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
  // sidecar-side voice loop stays the only voice surface.
  if (route.kind === "panel") {
    const Body = getRoomBody(route.key);
    return (
      <div className="jarvis-v2-root jarvis-v2-panel-mode">
        <RoomActionBusProvider>
          <Body mode="expanded" />
        </RoomActionBusProvider>
      </div>
    );
  }

  return (
    <div className="jarvis-v2-root">
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

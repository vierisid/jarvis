import React from "react";
import { useV2Route } from "./router";
import { AppShell } from "./shell/AppShell";
import { PrimitivesPage } from "./pages/PrimitivesPage";
import { RoomDispatcher } from "./rooms/RoomDispatcher";
import { RoomActionBusProvider } from "./rooms/useRoomActionBus";
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
 */
export function AppShellV2() {
  const route = useV2Route();

  return (
    <div className="jarvis-v2-root">
      {route.kind === "primitives" ? (
        <PrimitivesPage />
      ) : (
        <RoomActionBusProvider>
          <AppShell />
          {route.kind === "room" && <RoomDispatcher roomKey={route.key} />}
        </RoomActionBusProvider>
      )}
    </div>
  );
}

import React from "react";
import { useV2Route } from "./router";
import { AppShell } from "./shell/AppShell";
import { PrimitivesPage } from "./pages/PrimitivesPage";
import { RoomDispatcher } from "./rooms/RoomDispatcher";
import "./v2.css";
import "./ui/primitives.css";

/**
 * v2 root. Always renders the AppShell (so the thread is preserved across
 * Room navigation) plus an optional Room overlay or primitives showcase
 * on top, keyed off the route.
 */
export function AppShellV2() {
  const route = useV2Route();

  return (
    <div className="jarvis-v2-root">
      {route.kind === "primitives" ? (
        <PrimitivesPage />
      ) : (
        <>
          <AppShell />
          {route.kind === "room" && <RoomDispatcher roomKey={route.key} />}
        </>
      )}
    </div>
  );
}

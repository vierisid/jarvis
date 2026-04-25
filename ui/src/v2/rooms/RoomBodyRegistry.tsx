import React from "react";
import type { RoomKey } from "../router";
import { ToolsRoomBody } from "./tools/ToolsRoom";
import { LogsRoomBody } from "./logs/LogsRoom";

export type RoomBodyMode = "inline" | "expanded";

/**
 * Registry of mode-aware Room body components, indexed by RoomKey.
 * Each entry returns a component that accepts `{ mode }` and renders the
 * Room's content. Wrappers (RoomShell for overlay, RoomWindow for inline)
 * use this registry to fetch the right body for a given key.
 *
 * Rooms not yet built (Phase 6.2+) fall back to a small placeholder.
 */
export type RoomBodyComponent = React.ComponentType<{ mode: RoomBodyMode }>;

const REGISTRY: Partial<Record<RoomKey, RoomBodyComponent>> = {
  tools: ToolsRoomBody,
  logs: LogsRoomBody,
  // 6.3 — agents
  // 6.4 — workflows
  // 6.5 — memory
  // 6.6 — authority
  // 6.7 — calendar / goals / sites / settings
};

/**
 * Resolve a RoomBody for a key. Returns a placeholder component when the
 * Room hasn't been built yet so the chrome (RoomWindow / RoomShell) still
 * renders predictably during the transitional Phase 6.x window.
 */
export function getRoomBody(key: RoomKey): RoomBodyComponent {
  return REGISTRY[key] ?? ComingSoonBody;
}

function ComingSoonBody() {
  return (
    <div
      style={{
        padding: "var(--s-8)",
        fontFamily: "var(--font-display)",
        fontStyle: "italic",
        color: "var(--ink-3)",
        textAlign: "center",
      }}
    >
      This Room hasn't been built yet — Phase 6.2+ will fill it in.
    </div>
  );
}

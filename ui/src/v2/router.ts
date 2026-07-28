import { useEffect, useState } from "react";
import { isDevToolsEnabled } from "./devtools";

/**
 * v2 route union.
 *  - `home` mounts the AppShell (Thread + Rail + Composer).
 *  - `primitives` mounts the Phase 1 showcase.
 *  - `room` is the Phase 6 fullscreen Room overlay (used inside the dashboard
 *    when the user navigates within the SPA).
 *  - `panel` is the bare-room mode used when the sidecar spawns a Room as a
 *    standalone native window (T18 — "Jarvis open settings"). Renders ONLY
 *    the RoomBody, no AppShell, no voice handlers — so the pebble's sidecar-
 *    side voice loop is the single source of voice input (no double-voice).
 *
 * Hash format:
 *   #/                — home
 *   #/_primitives     — primitives showcase
 *   #/_room_<key>     — Room takeover (within AppShell)
 *   #/_panel_<key>    — Room as a standalone panel (no AppShell, no voice)
 */
export type RoomKey =
  | "workflows"
  | "memory"
  | "tools"
  | "agents"
  | "agent_strip"
  | "authority"
  | "logs"
  | "calendar"
  | "goals"
  | "tasks"
  | "content"
  | "workspaces"
  | "usage"
  | "settings";

export type V2Route =
  | { kind: "home" }
  | { kind: "primitives" }
  | { kind: "kit" }
  | { kind: "states" }
  | { kind: "billing" }
  | { kind: "room"; key: RoomKey }
  | { kind: "panel"; key: RoomKey }
  | { kind: "palette" }
  | { kind: "task"; id: string }
  | { kind: "answer"; id: string };

export const ROOM_KEYS: ReadonlySet<RoomKey> = new Set([
  "workflows",
  "memory",
  "tools",
  "agents",
  "agent_strip",
  "authority",
  "logs",
  "calendar",
  "goals",
  "tasks",
  "content",
  "workspaces",
  "usage",
  "settings",
]);

export function getV2Route(): V2Route {
  if (typeof window === "undefined") return { kind: "home" };
  const hash = window.location.hash.replace(/^#\/?/, "");
  if (hash === "_primitives") return { kind: "primitives" };
  // Design showcases are dev-only: #/_billing renders fake invoice rows and
  // #/_states fake failure takeovers — not for production users.
  if (hash === "_kit") return isDevToolsEnabled() ? { kind: "kit" } : { kind: "home" };
  if (hash === "_states") return isDevToolsEnabled() ? { kind: "states" } : { kind: "home" };
  if (hash === "_billing") return isDevToolsEnabled() ? { kind: "billing" } : { kind: "home" };
  if (hash === "_palette") return { kind: "palette" };
  if (hash.startsWith("_room_")) {
    const key = hash.slice("_room_".length);
    if (ROOM_KEYS.has(key as RoomKey)) {
      return { kind: "room", key: key as RoomKey };
    }
  }
  if (hash.startsWith("_panel_")) {
    const key = hash.slice("_panel_".length);
    if (ROOM_KEYS.has(key as RoomKey)) {
      return { kind: "panel", key: key as RoomKey };
    }
  }
  if (hash.startsWith("_task_")) {
    const id = hash.slice("_task_".length);
    if (id) return { kind: "task", id };
  }
  if (hash.startsWith("_answer_")) {
    const id = hash.slice("_answer_".length);
    if (id) return { kind: "answer", id };
  }
  return { kind: "home" };
}

export function useV2Route(): V2Route {
  const [route, setRoute] = useState<V2Route>(getV2Route);

  useEffect(() => {
    const onHashChange = () => setRoute(getV2Route());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  return route;
}

export function navigateV2(route: V2Route): void {
  let hash = "#/";
  if (route.kind === "primitives") hash = "#/_primitives";
  else if (route.kind === "kit") hash = "#/_kit";
  else if (route.kind === "states") hash = "#/_states";
  else if (route.kind === "billing") hash = "#/_billing";
  else if (route.kind === "palette") hash = "#/_palette";
  else if (route.kind === "room") hash = `#/_room_${route.key}`;
  else if (route.kind === "panel") hash = `#/_panel_${route.key}`;
  else if (route.kind === "task") hash = `#/_task_${route.id}`;
  else if (route.kind === "answer") hash = `#/_answer_${route.id}`;
  if (window.location.hash !== hash) {
    window.location.hash = hash;
  }
}

/** Convenience: open a Room by key. */
export function openRoom(key: RoomKey): void {
  navigateV2({ kind: "room", key });
}

/** Convenience: close any open Room and return to the thread. */
export function closeRoom(): void {
  navigateV2({ kind: "home" });
}

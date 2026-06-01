import { useEffect, useState } from "react";

/**
 * v2 route union. `home` mounts the AppShell (Thread + Rail + Composer).
 * `primitives` mounts the Phase 1 showcase. `room` is the Phase 6 fullscreen
 * Room overlay; the `key` discriminates which Room.
 *
 * Hash format:
 *   #/                — home
 *   #/_primitives     — primitives showcase
 *   #/_room_<key>     — Room takeover, key one of RoomKey
 */
export type RoomKey =
  | "workflows"
  | "memory"
  | "tools"
  | "agents"
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
  | { kind: "room"; key: RoomKey };

const ROOM_KEYS: ReadonlySet<RoomKey> = new Set([
  "workflows",
  "memory",
  "tools",
  "agents",
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
  if (hash.startsWith("_room_")) {
    const key = hash.slice("_room_".length);
    if (ROOM_KEYS.has(key as RoomKey)) {
      return { kind: "room", key: key as RoomKey };
    }
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
  else if (route.kind === "room") hash = `#/_room_${route.key}`;
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

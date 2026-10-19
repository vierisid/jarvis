import type { BriefRoomId, BriefRoute } from "../contracts";
import type { RoomKey } from "../../v2/router";
import type { BriefRollout } from "./release";
import { briefHash, resolveBriefEntry, type BriefEntryRoute } from "./route";

/** Only foreground destinations with equivalent Brief rooms are aliases.
 * Native panels, result windows, setup and advanced routes keep their owners. */
export const FOREGROUND_ALIASES = {
  "#/": "today", "#/_room_workflows": "workflows", "#/_room_memory": "memory",
  "#/_room_goals": "goals", "#/_room_authority": "authority", "#/_room_usage": "billing",
  "#/_room_settings": "settings",
} as const satisfies Record<string, BriefRoomId>;
export const LEGACY_ROOMS: Record<BriefRoomId, RoomKey | null> = {
  today: null, workflows: "workflows", workflow: "workflows", "workflow-preview": "workflows",
  "workflow-draft": "workflows", "workflow-runs": "workflows", "workflow-context": "workflows",
  "all-workflows": "workflows", opportunities: "workflows", "needs-you": "authority", goals: "goals",
  "completed-goals": "goals", memory: "memory", "memory-detail": "memory", "connected-workspace": "settings",
  authority: "authority", profile: "settings", settings: "settings", billing: "usage",
};

function directRoute(href: string): BriefRoute | null {
  const url = new URL(href, "http://localhost");
  url.searchParams.set("brief", "1");
  const entry = resolveBriefEntry(url.toString());
  return entry.kind === "brief" ? entry.route : null;
}

export function resolveReleaseEntry(href: string, rollout: BriefRollout, devtools = false): BriefEntryRoute {
  const url = new URL(href, "http://localhost");
  if (url.searchParams.has("onboarding")) return { kind: "legacy" };
  // F25 maintenance bookmarks predate the explicit brief=0 override. Existing
  // Settings tab/device links must still reach their canonical v2 handlers.
  if (url.searchParams.get("briefMaintenance") === "1"
    || (url.hash === "#/_room_settings" && (url.searchParams.has("settingsTab") || url.searchParams.has("sidecarId")))) {
    return { kind: "legacy" };
  }
  if (url.searchParams.getAll("brief").length > 1) return { kind: "legacy" };
  const flag = url.searchParams.get("brief");
  if (flag === "0") return { kind: "legacy" };
  // Internal review remains explicit and uses the existing developer-tools gate.
  // It cannot turn foreground aliases on or enable feature providers.
  if (devtools) {
    const internal = resolveBriefEntry(href);
    if (internal.kind !== "legacy") return internal;
  }
  if (rollout === "off" || (rollout === "cohort" && flag !== "1") || (flag !== null && flag !== "1")) {
    return { kind: "legacy" };
  }
  const route = directRoute(href);
  if (route) return { kind: "brief", route };
  const hash = url.hash || "#/";
  const room = Object.hasOwn(FOREGROUND_ALIASES, hash) ? FOREGROUND_ALIASES[hash as keyof typeof FOREGROUND_ALIASES] : null;
  return room ? { kind: "brief", route: { room, selection: {} } } : { kind: "legacy" };
}

/** v2 cannot parse Brief selection queries. Keep the exact typed return route in
 * a separate URL parameter, while its hash resolves to a usable legacy parent.
 * No storage, domain write, migration, or silent replay is involved. */
export function rollbackHref(href: string): string | null {
  const route = directRoute(href);
  if (!route) return null;
  const url = new URL(href, "http://localhost");
  url.searchParams.set("brief", "0");
  url.searchParams.set("briefReturn", briefHash(route));
  const room = LEGACY_ROOMS[route.room];
  url.hash = room ? `#/_room_${room}` : "#/";
  return url.toString();
}

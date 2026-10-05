import { BRIEF_ROOM_IDS, type BriefRoute, type BriefSelection } from "../contracts";

export type BriefEntryRoute = { kind: "legacy" } | { kind: "preview" } | { kind: "brief"; route: BriefRoute };
const IDS: ReadonlySet<string> = new Set(BRIEF_ROOM_IDS);
const SELECTION_KEYS = ["flowId", "versionId", "runId", "goalId", "factId", "approvalId", "workItemId", "opportunityId"] as const;

export function resolveBriefEntry(href: string): BriefEntryRoute {
  const url = new URL(href, "http://localhost");
  // Keep the existing reset/resume owner. Never mount a second reset handler.
  if (url.searchParams.has("onboarding")) return { kind: "legacy" };
  const flag = url.searchParams.get("brief");
  if (flag === "preview" && url.hash === "#/_brief_preview") return { kind: "preview" };
  if (flag !== "1" || !url.hash.startsWith("#/brief/")) return { kind: "legacy" };
  const [room, query = ""] = url.hash.slice("#/brief/".length).split("?");
  if (!room || !IDS.has(room)) return { kind: "legacy" };
  const params = new URLSearchParams(query);
  const selection: BriefSelection = {};
  for (const key of SELECTION_KEYS) {
    const value = params.get(key);
    if (value) selection[key] = value;
  }
  return { kind: "brief", route: { room: room as BriefRoute["room"], selection } };
}

export function briefHash(route: BriefRoute): string {
  const query = new URLSearchParams();
  for (const key of SELECTION_KEYS) {
    const value = route.selection[key];
    if (value) query.set(key, value);
  }
  const suffix = query.toString();
  return `#/brief/${route.room}${suffix ? `?${suffix}` : ""}`;
}

export function legacyHref(href: string, hash = "#/"): string {
  const url = new URL(href, "http://localhost");
  url.searchParams.delete("brief");
  url.hash = hash;
  return url.toString();
}

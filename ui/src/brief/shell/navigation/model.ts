import type { BillingSnapshot } from "../../../v2/billing/useBilling";
import type { BriefReadState, BriefRoomId, BriefRoute, BriefViewPort } from "../../contracts";
import { isBriefCapabilityEnabled } from "../../../../../src/brief/capabilities";

export interface BriefAccount {
  name: string | null;
  plan: BriefReadState<string>;
}
export interface BriefNavigationData {
  workspaceName: string | null;
  account: BriefAccount;
  connection: "connected" | "reconnecting" | "offline" | "unknown";
  /** Do not infer hosting from a healthy socket. */
  hosting: "hosted" | "self" | "unknown";
  badges: Partial<Record<"workflows" | "opportunities" | "needs-you", number>>;
  /** Supplied by the room's real view, never a source ID used as a title. */
  objectTitle?: string;
}
export interface BriefNavigationBinding {
  capabilities: unknown;
  view: BriefViewPort<BriefNavigationData>;
}

export const UNKNOWN_NAVIGATION: BriefNavigationData = {
  workspaceName: null, account: { name: null, plan: { status: "unavailable", reason: "Plan unavailable" } },
  connection: "unknown", hosting: "unknown", badges: {},
};

/** F-25 must prove the legacy/update/emergency paths before live activation.
 * Explicit fixtures are allowed only in the isolated development preview. */
export function canMountNavigation(mode: "live" | "preview", binding?: BriefNavigationBinding): boolean {
  return !!binding && (mode === "preview" || (binding.view.source === "live"
    && isBriefCapabilityEnabled(binding.capabilities, "navigationCompatibility")));
}

export function navigationData(view: BriefViewPort<BriefNavigationData>): BriefNavigationData {
  const state = view.state;
  if (state.status === "ready") return state.data;
  if (state.status === "stale") return {
    ...state.data, connection: "unknown", badges: {},
    account: { ...state.data.account, plan: { status: "unavailable", reason: "Plan unavailable" } },
  };
  return UNKNOWN_NAVIGATION;
}

/** Pure adapter for the existing shared /api/billing reader. No second fetch,
 * hard-coded plan tier, customer email, or mock billing model enters the shell. */
export function planFromBilling(billing: BillingSnapshot): BriefReadState<string> {
  if (billing.state === "self") return { status: "ready", data: "Self-hosted" };
  if (billing.state === "unknown") return { status: "loading" };
  if (billing.stale || billing.state !== "ready" || !billing.summary) return { status: "unavailable", reason: "Plan unavailable" };
  const plans = billing.summary.plans;
  if (!Array.isArray(plans) || plans.some(p => !p || typeof p.name !== "string" || !p.name.trim())) {
    return { status: "unavailable", reason: "Plan unavailable" };
  }
  return { status: "ready", data: plans.length ? plans.map(p => p.name.trim()).join(" + ") : "No active plan" };
}

export function planLabel(plan: BriefReadState<string>): string {
  return plan.status === "ready" ? plan.data : plan.status === "loading" ? "Loading plan…" : "Plan unavailable";
}
export function initials(name: string | null): string {
  return name?.trim().split(/\s+/).filter(Boolean).slice(0, 2).map(p => [...p][0]).join("").toLocaleUpperCase() || "?";
}
export function badgeLabel(value: number | undefined): string | null {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value > 99 ? "99+" : String(value) : null;
}
export function connectionLabel(data: BriefNavigationData): string {
  const subject = data.hosting === "hosted" ? "Hosted brain" : "Jarvis";
  return data.connection === "connected" ? `${subject} connected` : data.connection === "reconnecting" ? `${subject} reconnecting`
    : data.connection === "offline" ? `${subject} offline` : "Connection status unavailable";
}

export type NavRoom = "today" | "workflows" | "opportunities" | "needs-you" | "goals" | "memory" | "connected-workspace" | "authority";
export const PRIMARY_NAV: readonly NavRoom[] = ["today", "workflows", "opportunities", "needs-you"];
export const DIRECTION_NAV: readonly NavRoom[] = ["goals", "memory"];
export const UTILITY_NAV: readonly NavRoom[] = ["connected-workspace", "authority"];
export const NAV_LABELS: Record<NavRoom, string> = {
  today: "Today", workflows: "Workflows", opportunities: "Opportunities", "needs-you": "Needs you",
  goals: "Goals", memory: "Memory", "connected-workspace": "Connected workspace", authority: "Authority & settings",
};
export function parentRoom(room: BriefRoomId): NavRoom | null {
  if (room === "workflow" || room.startsWith("workflow-") || room === "all-workflows") return "workflows";
  if (room === "completed-goals") return "goals";
  if (room === "memory-detail") return "memory";
  return [...PRIMARY_NAV, ...DIRECTION_NAV, ...UTILITY_NAV].includes(room as NavRoom) ? room as NavRoom : null;
}
export function navigationRoute(room: BriefRoomId, current: BriefRoute): BriefRoute {
  // Clicking the selected destination is a no-op: never discard its selected object.
  return current.room === room ? current : { room, selection: {} };
}

/** The adapter only declares real parents as links. Workspace is orientation,
 * not the removed workspace selector. Object titles come from the room. */
export function breadcrumbs(route: BriefRoute, title: string, objectTitle?: string) {
  const parent = parentRoom(route.room);
  return {
    parent: parent && parent !== route.room ? { label: NAV_LABELS[parent], route: { room: parent, selection: {} } as BriefRoute } : null,
    current: objectTitle?.trim() || title,
  };
}

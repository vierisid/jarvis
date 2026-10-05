import type { ComponentType, ReactNode } from "react";
import type { Theme } from "../v2/shell/useTheme";
import type { RoomKey } from "../v2/router";

// Presentation destinations only. Domain schemas/capabilities remain owned by F-01.
export const BRIEF_ROOM_IDS = [
  "today", "workflows", "workflow", "workflow-preview", "workflow-draft",
  "workflow-runs", "workflow-context", "all-workflows", "opportunities",
  "needs-you", "goals", "completed-goals", "memory", "memory-detail",
  "connected-workspace", "authority", "profile", "settings", "billing",
] as const;
export type BriefRoomId = typeof BRIEF_ROOM_IDS[number];

/** These are existing source IDs carried through the URL, never UI array indexes. */
export interface BriefSelection {
  flowId?: string;
  versionId?: string;
  runId?: string;
  goalId?: string;
  factId?: string;
  approvalId?: string;
  workItemId?: string;
  opportunityId?: string;
}
export interface BriefRoute { room: BriefRoomId; selection: Readonly<BriefSelection> }

/** Unavailable is not empty, and stale data is not a successful fresh read. */
export type BriefReadState<T> =
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "empty" }
  | { status: "stale"; data: T; reason: string }
  | { status: "unavailable" | "unsupported"; reason: string };

export interface BriefViewPort<T> {
  source: "live" | "fixture";
  state: BriefReadState<T>;
  refresh?: () => void;
}
export interface BriefShellPort {
  mode: "live" | "preview";
  route: BriefRoute;
  sidebar: "expanded" | "rail";
  chatOpen: boolean;
  theme: Theme;
  setSidebar: (value: "expanded" | "rail") => void;
  setChatOpen: (value: boolean) => void;
  setTheme: (value: Theme) => void;
  navigate: (route: BriefRoute) => void;
}
export interface BriefRoomProps<T> { shell: BriefShellPort; view: BriefViewPort<T> }
export interface BriefRoomModule {
  id: BriefRoomId;
  title: string;
  legacyRoom?: RoomKey;
  // Each room owns its typed view binding; the registry never casts domain data.
  Body?: ComponentType<{ shell: BriefShellPort }>;
}
export type BriefRoomRegistry = Readonly<Partial<Record<BriefRoomId, BriefRoomModule>>>;
export type BriefGate = ComponentType<{ children: ReactNode }>;

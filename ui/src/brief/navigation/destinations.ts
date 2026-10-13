import type { BriefRoomId, BriefRoute } from "../contracts";
import { ROOM_KEYS, type RoomKey } from "../../v2/router";
import type { SettingsTab } from "../../v2/rooms/settings/SettingsRoom";
import { legacyHref } from "../entry/route";

export type NavigationTarget =
  | { kind: "brief"; route: BriefRoute }
  | { kind: "legacy"; hash: string; settingsTab?: SettingsTab; sidecarId?: string }
  | { kind: "conversation"; itemId: string };
type Destination = { label: string; owner: string; legacy: NavigationTarget & { kind: "legacy" }; room?: BriefRoomId };
const room = (key: RoomKey) => ({ kind: "legacy" as const, hash: `#/_room_${key}` });
const settings = (settingsTab: SettingsTab) => ({ ...room("settings"), settingsTab });

/** Explicit compatibility inventory. Opening a destination never performs its action. */
export const DESTINATIONS = {
  authority: { label: "Authority", owner: "D-28 / AuthorityRoom", room: "authority", legacy: room("authority") },
  connections: { label: "Connected workspace", owner: "D-27 / F-22", room: "connected-workspace", legacy: room("tools") },
  "advanced-settings": { label: "Advanced settings and support", owner: "F-25 / SettingsRoom", legacy: settings("general") },
  "advanced-authority": { label: "Authority overrides and history", owner: "AuthorityRoom", legacy: room("authority") },
  "emergency-controls": { label: "Emergency pause and stop", owner: "AuthorityRoom", legacy: room("authority") },
  "capture-privacy": { label: "Capture, awareness opt-out and exclusions", owner: "SidecarConfigEditor", legacy: settings("sidecar") },
  credentials: { label: "Provider credentials and models", owner: "LLMTab", legacy: settings("llm") },
  channels: { label: "Channels and speech providers", owner: "ChannelsTab", legacy: settings("channels") },
  integrations: { label: "Integration credentials", owner: "IntegrationsTab", legacy: settings("integrations") },
  tools: { label: "Tools and integration catalog", owner: "ToolsRoom", legacy: room("tools") },
  "agent-strip": { label: "Agent activity", owner: "AgentStrip", legacy: room("agent_strip") },
  "voice-settings": { label: "Voice settings", owner: "ChannelsTab / VoiceTab", legacy: settings("channels") },
  "realtime-voice": { label: "Realtime voice setup", owner: "VoiceTab", legacy: settings("voice") },
  devices: { label: "Device setup, updates and revocation", owner: "SidecarTab", legacy: settings("sidecar") },
  logs: { label: "Logs and diagnostics", owner: "LogsRoom", legacy: room("logs") },
  usage: { label: "Usage", owner: "UsageRoom", legacy: room("usage") },
  tasks: { label: "Active tasks and recovery", owner: "TasksRoom / TaskDetail", legacy: room("tasks") },
  agents: { label: "Agents and execution diagnostics", owner: "AgentsRoom", legacy: room("agents") },
  calendar: { label: "Calendar", owner: "CalendarRoom", legacy: room("calendar") },
  content: { label: "Content", owner: "ContentRoom", legacy: room("content") },
  workspaces: { label: "Workspaces", owner: "WorkspacesRoom", legacy: room("workspaces") },
  "legacy-dashboard": { label: "Current dashboard and Arrange", owner: "AppShell", legacy: { kind: "legacy", hash: "#/" } },
} as const satisfies Record<string, Destination>;
export type DestinationId = keyof typeof DESTINATIONS;
export type Resolution = { target: NavigationTarget; message: string | null };
export type RoomAvailability = (room: BriefRoomId) => boolean;
const mapped: Partial<Record<RoomKey | "home", BriefRoomId>> = {
  home: "today", workflows: "workflows", memory: "memory", tools: "connected-workspace",
  authority: "authority", goals: "goals", settings: "settings",
};

export function destination(id: DestinationId, available: RoomAvailability): Resolution {
  const value: Destination = DESTINATIONS[id];
  if (value.room && available(value.room)) return { target: { kind: "brief", route: { room: value.room, selection: {} } }, message: null };
  return { target: value.legacy, message: `Opening ${value.label} in the current dashboard.` };
}

/** Voice/command navigation only. Room actions still belong to their canonical handler/ack bus. */
export function roomIntent(key: string, available: RoomAvailability, hasRoomAction = false): Resolution {
  if (Object.hasOwn(mapped, key) && !hasRoomAction) {
    const id = mapped[key as keyof typeof mapped]!;
    if (available(id)) return { target: { kind: "brief", route: { room: id, selection: {} } }, message: null };
  }
  if (key === "home") return { target: { kind: "legacy", hash: "#/" }, message: "Opening the current dashboard." };
  if (ROOM_KEYS.has(key as RoomKey)) return { target: room(key as RoomKey), message: "This control is available in the current dashboard." };
  return { target: settings("general"), message: "That view is not part of Brief. Advanced settings and support has links to the retained controls." };
}

/** Existing links (including native panels) retain their exact owner. Never turn a panel into a voice shell. */
export function legacyLink(hash: string): Resolution | null {
  if (["#/", "#/_primitives", "#/_kit", "#/_states", "#/_billing", "#/_palette"].includes(hash))
    return { target: { kind: "legacy", hash }, message: null };
  const match = /^#\/_(room|panel)_(.+)$/.exec(hash);
  if (match && ROOM_KEYS.has(match[2] as RoomKey)) return { target: { kind: "legacy", hash }, message: null };
  // Opaque task/answer suffixes belong to the released parser. Preserve them byte for byte.
  if (/^#\/_(task|answer)_[^\s]+$/.test(hash)) return { target: { kind: "legacy", hash }, message: null };
  return null;
}

export function targetHref(href: string, target: NavigationTarget & { kind: "legacy" }): string {
  const url = new URL(legacyHref(href, target.hash));
  url.searchParams.delete("settingsTab");
  url.searchParams.delete("sidecarId");
  url.searchParams.set("briefMaintenance", "1");
  if (target.settingsTab) url.searchParams.set("settingsTab", target.settingsTab);
  if (target.settingsTab === "sidecar" && target.sidecarId) url.searchParams.set("sidecarId", target.sidecarId);
  return url.href;
}

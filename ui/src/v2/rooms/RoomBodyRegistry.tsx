import React from "react";
import type { RoomKey } from "../router";
import { ToolsRoomBody } from "./tools/ToolsRoom";
import { LogsRoomBody } from "./logs/LogsRoom";
import { AgentsRoomBody } from "./agents/AgentsRoom";
import { WorkflowsRoomBody } from "./workflows/WorkflowsRoom";
import { MemoryRoomBody } from "./memory/MemoryRoom";
import { AuthorityRoomBody } from "./authority/AuthorityRoom";
import { CalendarRoomBody } from "./calendar/CalendarRoom";
import { GoalsRoomBody } from "./goals/GoalsRoom";
import { TasksRoomBody } from "./tasks/TasksRoom";
import { ContentRoomBody } from "./content/ContentRoom";
import { WorkspacesRoomBody } from "./workspaces/WorkspacesRoom";
import { UsageRoomBody } from "./usage/UsageRoom";
import { SettingsRoomBody } from "./settings/SettingsRoom";

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
  agents: AgentsRoomBody,
  workflows: WorkflowsRoomBody,
  memory: MemoryRoomBody,
  authority: AuthorityRoomBody,
  calendar: CalendarRoomBody,
  goals: GoalsRoomBody,
  tasks: TasksRoomBody,
  content: ContentRoomBody,
  workspaces: WorkspacesRoomBody,
  usage: UsageRoomBody,
  settings: SettingsRoomBody,
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

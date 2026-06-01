/**
 * Shape returned by `GET /api/palette/search`. Mirrors the daemon-side
 * `PaletteResult` in `src/daemon/api-routes.ts`. Designed to map directly
 * onto `<InlineCard>` props when the user picks an object result.
 */
export type PaletteResultType =
  | "workflow"
  | "memory"
  | "tool"
  | "agent"
  | "authority"
  | "log";

export type PaletteResult = {
  type: PaletteResultType;
  id: string;
  ref: string;
  title: string;
  summary?: string;
  meta?: string;
  status?: { label: string; tone: "ok" | "warn" | "neutral" | "accent" };
};

/**
 * Room navigation entries shown in the palette when the query is empty
 * or matches a Room name. Selecting one opens the Room (Phase 6 stub for
 * now). The `key` becomes the navigation route; the `label` matches the
 * Room build order from the roadmap.
 */
export type PaletteNavEntry = {
  key:
    | "tools"
    | "logs"
    | "agents"
    | "workflows"
    | "memory"
    | "authority"
    | "calendar"
    | "goals"
    | "tasks"
    | "content"
    | "workspaces"
    | "usage"
    | "settings";
  label: string;
  hint: string;
};

export const ROOM_NAV_ENTRIES: PaletteNavEntry[] = [
  { key: "workflows", label: "Workflows", hint: "Run or edit saved agent flows" },
  { key: "memory", label: "Memory", hint: "Recall what Jarvis knows" },
  { key: "agents", label: "Agents", hint: "Roster, status, last run" },
  { key: "authority", label: "Authority", hint: "Scopes, allowlists, approvals" },
  { key: "tools", label: "Tools", hint: "Catalog + capability flags" },
  { key: "logs", label: "Logs", hint: "Filterable event stream" },
  { key: "calendar", label: "Calendar", hint: "This week + commitments" },
  { key: "goals", label: "Goals", hint: "OKR hierarchy + scoring" },
  { key: "tasks", label: "Tasks", hint: "Kanban + due dates + priority" },
  { key: "content", label: "Content", hint: "Drafts, scheduled, published" },
  { key: "workspaces", label: "Workspaces", hint: "Dev projects, git, dev servers" },
  { key: "usage", label: "Usage", hint: "LLM token usage, filterable by tier/model/task/date" },
  { key: "settings", label: "Settings", hint: "Providers, voice, shortcuts" },
];

/**
 * Map a palette Room nav key to the `ObjectType` used by `<InlineCard>`.
 * 1:1 except `workflows` → `workflow`, `agents` → `agent`, `logs` → `log`.
 */
export function navKeyToObjectType(
  key: PaletteNavEntry["key"],
):
  | "workflow"
  | "memory"
  | "tool"
  | "agent"
  | "authority"
  | "log"
  | "calendar"
  | "goals"
  | "tasks"
  | "content"
  | "workspaces"
  | "usage"
  | "settings" {
  switch (key) {
    case "workflows":
      return "workflow";
    case "agents":
      return "agent";
    case "logs":
      return "log";
    case "tools":
      return "tool";
    default:
      return key;
  }
}

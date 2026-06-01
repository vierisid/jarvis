import React, { Suspense } from "react";
import type { RoomKey } from "../router";
import { RoomPlaceholder } from "./RoomPlaceholder";
import { RoomLoadErrorBoundary } from "./RoomLoadErrorBoundary";

const ToolsRoom = React.lazy(() =>
  import("./tools/ToolsRoom").then((m) => ({ default: m.ToolsRoom })),
);

const LogsRoom = React.lazy(() =>
  import("./logs/LogsRoom").then((m) => ({ default: m.LogsRoom })),
);

const AgentsRoom = React.lazy(() =>
  import("./agents/AgentsRoom").then((m) => ({ default: m.AgentsRoom })),
);

const WorkflowsRoom = React.lazy(() =>
  import("./workflows/WorkflowsRoom").then((m) => ({ default: m.WorkflowsRoom })),
);

const MemoryRoom = React.lazy(() =>
  import("./memory/MemoryRoom").then((m) => ({ default: m.MemoryRoom })),
);

const AuthorityRoom = React.lazy(() =>
  import("./authority/AuthorityRoom").then((m) => ({ default: m.AuthorityRoom })),
);

const CalendarRoom = React.lazy(() =>
  import("./calendar/CalendarRoom").then((m) => ({ default: m.CalendarRoom })),
);

const GoalsRoom = React.lazy(() =>
  import("./goals/GoalsRoom").then((m) => ({ default: m.GoalsRoom })),
);

const TasksRoom = React.lazy(() =>
  import("./tasks/TasksRoom").then((m) => ({ default: m.TasksRoom })),
);

const ContentRoom = React.lazy(() =>
  import("./content/ContentRoom").then((m) => ({ default: m.ContentRoom })),
);

const WorkspacesRoom = React.lazy(() =>
  import("./workspaces/WorkspacesRoom").then((m) => ({ default: m.WorkspacesRoom })),
);

const SettingsRoom = React.lazy(() =>
  import("./settings/SettingsRoom").then((m) => ({ default: m.SettingsRoom })),
);

const UsageRoom = React.lazy(() =>
  import("./usage/UsageRoom").then((m) => ({ default: m.UsageRoom })),
);

type LazyRoomEntry = {
  Component: React.ComponentType;
  title: string;
  loadingDesc: string;
};

/**
 * Lazy-loaded Room registry. Add a new room here and `RoomDispatcher`
 * picks it up automatically with the load-error boundary already wired.
 * Phase 6.8 — collapsed 12 near-identical Suspense blocks into one
 * registry + one render path, and added the load error boundary at
 * the same level so failed lazy imports show a Retry overlay instead
 * of hanging the placeholder forever.
 */
const LAZY_ROOMS: Partial<Record<RoomKey, LazyRoomEntry>> = {
  tools: { Component: ToolsRoom, title: "Tools", loadingDesc: "Fetching tool catalog…" },
  logs: { Component: LogsRoom, title: "Logs", loadingDesc: "Loading event stream…" },
  agents: { Component: AgentsRoom, title: "Agents", loadingDesc: "Loading roster…" },
  workflows: { Component: WorkflowsRoom, title: "Workflows", loadingDesc: "Loading workflow editor…" },
  memory: { Component: MemoryRoom, title: "Memory", loadingDesc: "Loading entities…" },
  authority: { Component: AuthorityRoom, title: "Authority", loadingDesc: "Loading approvals…" },
  calendar: { Component: CalendarRoom, title: "Calendar", loadingDesc: "Loading this week…" },
  goals: { Component: GoalsRoom, title: "Goals", loadingDesc: "Loading your goals…" },
  tasks: { Component: TasksRoom, title: "Tasks", loadingDesc: "Loading your tasks…" },
  content: { Component: ContentRoom, title: "Content", loadingDesc: "Loading the pipeline…" },
  workspaces: { Component: WorkspacesRoom, title: "Workspaces", loadingDesc: "Loading projects…" },
  usage: { Component: UsageRoom, title: "Usage", loadingDesc: "Loading usage telemetry…" },
  settings: { Component: SettingsRoom, title: "Settings", loadingDesc: "Loading configuration…" },
};

/**
 * Mounts the right Room component for the active route key. Wraps the
 * lazy import in a Suspense fallback (slide-up animation doesn't wait
 * on the chunk) and a `RoomLoadErrorBoundary` (failed lazy imports
 * surface a Retry button + Esc-to-close instead of hanging the
 * placeholder forever).
 */
export function RoomDispatcher({ roomKey }: { roomKey: RoomKey }) {
  const lazyEntry = LAZY_ROOMS[roomKey];
  if (lazyEntry) {
    const { Component, title, loadingDesc } = lazyEntry;
    return (
      <RoomLoadErrorBoundary roomKey={roomKey} title={title}>
        <Suspense
          fallback={
            <RoomPlaceholder
              roomKey={roomKey}
              title={title}
              phaseTag="Loading…"
              description={loadingDesc}
            />
          }
        >
          <Component />
        </Suspense>
      </RoomLoadErrorBoundary>
    );
  }

  // Fall-through for any future RoomKey not yet wired into the registry.
  const meta = ROOM_META[roomKey];
  return (
    <RoomPlaceholder
      roomKey={roomKey}
      title={meta.title}
      subtitle={meta.subtitle}
      phaseTag={meta.phaseTag}
      description={meta.description}
    />
  );
}

type RoomMeta = {
  title: string;
  subtitle?: string;
  phaseTag: string;
  description: string;
};

const ROOM_META: Record<RoomKey, RoomMeta> = {
  tools: {
    title: "Tools",
    subtitle: "catalog · capability flags",
    phaseTag: "Phase 6.1 — Tools Room",
    description:
      "The full catalog of builtin and sidecar-routed tools, with capability flags (read / write / external / destructive) and per-tool detail.",
  },
  logs: {
    title: "Logs",
    subtitle: "events · awareness · audit",
    phaseTag: "Phase 6.2 — Logs Room",
    description:
      "Consolidated event stream from awareness, tasks, the content pipeline, and the authority audit trail. Filterable, with a live-tail toggle.",
  },
  agents: {
    title: "Agents",
    subtitle: "roster · health · delegation",
    phaseTag: "Phase 6.3 — Agents Room",
    description:
      "All specialist agents at a glance: status, last run, current task, and the delegation hierarchy that connects them.",
  },
  workflows: {
    title: "Workflows",
    subtitle: "list · graph · NL builder",
    phaseTag: "Phase 6.4 — Workflows Room",
    description:
      "Saved automations as a list and as a graph (xyflow). Edit nodes, trigger runs, and use the natural-language builder to compose new workflows.",
  },
  memory: {
    title: "Memory",
    subtitle: "entities · facts · relationships",
    phaseTag: "Phase 6.5 — Memory Room",
    description:
      "What Jarvis knows. Browse entities, facts, and relationships, or look at the knowledge constellation as a whole.",
  },
  authority: {
    title: "Authority",
    subtitle: "approvals · audit · grants",
    phaseTag: "Phase 6.6 — Authority Room",
    description:
      "The soft-gate approval queue, the full audit trail, scopes and grants, emergency controls, and the learning loop that suggests new auto-approvals.",
  },
  calendar: {
    title: "Calendar",
    subtitle: "this week · commitments",
    phaseTag: "Phase 6.7 — Calendar Room",
    description: "Your upcoming week alongside commitments Jarvis is tracking.",
  },
  goals: {
    title: "Goals",
    subtitle: "OKR hierarchy · check-ins",
    phaseTag: "Phase 6.7 — Goals Room",
    description:
      "Long-horizon goals with KR scoring, check-in cadence, and progress views.",
  },
  tasks: {
    title: "Tasks",
    subtitle: "kanban · due dates · priority",
    phaseTag: "Phase 6.7 — Tasks Room",
    description:
      "Your active commitments. Create, complete, reassign, and prioritize tasks.",
  },
  content: {
    title: "Content",
    subtitle: "drafts · scheduled · published",
    phaseTag: "Phase 6.7 — Content Pipeline Room",
    description:
      "8-stage pipeline (idea → research → outline → draft → assets → review → scheduled → published) for posts, blogs, videos, podcasts, and newsletters.",
  },
  workspaces: {
    title: "Workspaces",
    subtitle: "dev projects · git · dev servers",
    phaseTag: "Phase 6.7 — Workspaces Room",
    description:
      "Web app dev environments. Run dev servers, edit files, commit and push to GitHub.",
  },
  usage: {
    title: "Usage",
    subtitle: "LLM tokens · filterable telemetry",
    phaseTag: "Phase 6.8 — Usage Room",
    description:
      "Track LLM token consumption. Filter by task difficulty (tier), model, task (subsystem), provider, and date range.",
  },
  settings: {
    title: "Settings",
    subtitle: "providers · channels · sidecar",
    phaseTag: "Phase 6.7 — Settings Room",
    description:
      "Configuration: profile, LLM providers, channels, integrations, sidecar setup.",
  },
};

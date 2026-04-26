import React, { Suspense } from "react";
import type { RoomKey } from "../router";
import { RoomPlaceholder } from "./RoomPlaceholder";

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

/**
 * Mounts the right Room component for the active route key.
 *
 * Phase 6.0 shipped placeholder bodies for every key. Each Phase 6.x
 * sub-phase swaps in a lazy-loaded real Room. Suspense fallback keeps
 * the slide-up animation from waiting on the chunk download.
 */
export function RoomDispatcher({ roomKey }: { roomKey: RoomKey }) {
  if (roomKey === "tools") {
    return (
      <Suspense fallback={<RoomPlaceholder
        roomKey="tools"
        title="Tools"
        phaseTag="Loading…"
        description="Fetching tool catalog…"
      />}>
        <ToolsRoom />
      </Suspense>
    );
  }
  if (roomKey === "logs") {
    return (
      <Suspense fallback={<RoomPlaceholder
        roomKey="logs"
        title="Logs"
        phaseTag="Loading…"
        description="Loading event stream…"
      />}>
        <LogsRoom />
      </Suspense>
    );
  }
  if (roomKey === "agents") {
    return (
      <Suspense fallback={<RoomPlaceholder
        roomKey="agents"
        title="Agents"
        phaseTag="Loading…"
        description="Loading roster…"
      />}>
        <AgentsRoom />
      </Suspense>
    );
  }
  if (roomKey === "workflows") {
    return (
      <Suspense fallback={<RoomPlaceholder
        roomKey="workflows"
        title="Workflows"
        phaseTag="Loading…"
        description="Loading workflow editor…"
      />}>
        <WorkflowsRoom />
      </Suspense>
    );
  }
  if (roomKey === "memory") {
    return (
      <Suspense fallback={<RoomPlaceholder
        roomKey="memory"
        title="Memory"
        phaseTag="Loading…"
        description="Loading entities…"
      />}>
        <MemoryRoom />
      </Suspense>
    );
  }
  if (roomKey === "authority") {
    return (
      <Suspense fallback={<RoomPlaceholder
        roomKey="authority"
        title="Authority"
        phaseTag="Loading…"
        description="Loading approvals…"
      />}>
        <AuthorityRoom />
      </Suspense>
    );
  }
  if (roomKey === "calendar") {
    return (
      <Suspense fallback={<RoomPlaceholder
        roomKey="calendar"
        title="Calendar"
        phaseTag="Loading…"
        description="Loading this week…"
      />}>
        <CalendarRoom />
      </Suspense>
    );
  }
  if (roomKey === "goals") {
    return (
      <Suspense fallback={<RoomPlaceholder
        roomKey="goals"
        title="Goals"
        phaseTag="Loading…"
        description="Loading your goals…"
      />}>
        <GoalsRoom />
      </Suspense>
    );
  }
  if (roomKey === "tasks") {
    return (
      <Suspense fallback={<RoomPlaceholder
        roomKey="tasks"
        title="Tasks"
        phaseTag="Loading…"
        description="Loading your tasks…"
      />}>
        <TasksRoom />
      </Suspense>
    );
  }
  if (roomKey === "content") {
    return (
      <Suspense fallback={<RoomPlaceholder
        roomKey="content"
        title="Content"
        phaseTag="Loading…"
        description="Loading the pipeline…"
      />}>
        <ContentRoom />
      </Suspense>
    );
  }
  if (roomKey === "workspaces") {
    return (
      <Suspense fallback={<RoomPlaceholder
        roomKey="workspaces"
        title="Workspaces"
        phaseTag="Loading…"
        description="Loading projects…"
      />}>
        <WorkspacesRoom />
      </Suspense>
    );
  }
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
  settings: {
    title: "Settings",
    subtitle: "providers · channels · sidecar",
    phaseTag: "Phase 6.7 — Settings Room",
    description:
      "Configuration: profile, LLM providers, channels, integrations, sidecar setup.",
  },
};

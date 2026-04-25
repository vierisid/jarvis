import React, { Suspense } from "react";
import type { RoomKey } from "../router";
import { RoomPlaceholder } from "./RoomPlaceholder";

const ToolsRoom = React.lazy(() =>
  import("./tools/ToolsRoom").then((m) => ({ default: m.ToolsRoom })),
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
  sites: {
    title: "Sites",
    subtitle: "projects · pipeline",
    phaseTag: "Phase 6.7 — Sites Room",
    description:
      "Public sites and landing pages. Stage, draft, schedule, and publish.",
  },
  settings: {
    title: "Settings",
    subtitle: "providers · channels · sidecar",
    phaseTag: "Phase 6.7 — Settings Room",
    description:
      "Configuration: profile, LLM providers, channels, integrations, sidecar setup.",
  },
};

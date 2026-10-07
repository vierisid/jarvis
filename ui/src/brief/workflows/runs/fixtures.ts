import type {
  RunDetail,
  RunScope,
  RunStatus,
  RunSummary,
  WorkflowRunsPort,
} from "./model";
import { WorkflowRunsController } from "./controller";
export const RUN_SCOPE: RunScope = {
  scopeId: "run-preview-owner",
  flowId: "meeting",
  versionId: "meeting-v3",
};
export const RUN_CAPABILITY = {
  contractVersion: 1,
  capabilities: {
    workflowContext: {
      supported: true,
      ready: true,
      enabled: true,
      state: "ready",
      reason: null,
    },
  },
};
export function makeRunsFixture() {
  const records = new Map<string, RunDetail>();
  const statuses: RunStatus[] = [
    "paused",
    "succeeded",
    "running",
    "queued",
    "failed",
    "cancelled",
    "uncertain",
    "succeeded",
    "succeeded",
    "succeeded",
    "succeeded",
    "succeeded",
  ];
  for (let n = 12; n >= 1; n--) {
    const status = statuses[12 - n]!;
    const stopped = ["cancelled", "failed", "uncertain"].includes(status);
    const runId = `meeting-run-${String(n).padStart(3, "0")}`;
    const time = 1791356400000 - (12 - n) * 86400000;
    const run: RunDetail = {
      ...RUN_SCOPE,
      runId,
      versionId: n === 1 ? "meeting-v2" : RUN_SCOPE.versionId,
      label: `Run ${String(n).padStart(3, "0")}`,
      status,
      createdAt: time,
      startedAt: status === "queued" ? null : time,
      finishedAt: ["succeeded", "failed", "cancelled"].includes(status)
        ? time + 44000
        : null,
      summary:
        status === "paused"
          ? "Follow-up drafted. Nothing sent."
          : status === "succeeded"
            ? "Follow-up sent. A clear next step."
            : status === "uncertain"
              ? "The email outcome needs checking."
              : status === "failed"
                ? "The run stopped after preparing the draft."
                : status === "cancelled"
                  ? "Cancelled. Earlier actions remain recorded."
                  : status === "running"
                    ? "Preparing the next step."
                    : "Queued. Work has not started.",
      trigger: "Meeting ended",
      steps:
        status === "queued"
          ? []
          : [
              {
                id: "meeting",
                title: "Meeting ended",
                description: "Google Calendar",
                status: "succeeded",
                fields: [],
              },
              {
                id: "notes",
                title: "Read meeting notes",
                description: "Latest conversation with Alex",
                status: "succeeded",
                fields: [
                  {
                    label: "Output",
                    value:
                      "Alex wants to begin a pilot. Agree the scope and next date.",
                  },
                ],
              },
              {
                id: "draft",
                title: "Draft the follow-up",
                description: "Goal and email preferences",
                status: status === "running" ? "running" : "succeeded",
                fields: [
                  { label: "Input", value: "Summarise the agreed next step." },
                  {
                    label: "Output",
                    value:
                      "Our pilot: next steps\nLet's start with meeting follow-ups. Does the proposed date work for you?",
                  },
                  {
                    label: "Private field",
                    value: "PRIVATE_CANARY",
                    redacted: true,
                  },
                ],
              },
              {
                id: "review",
                title: "Review before sending",
                description:
                  status === "paused"
                    ? "Your email approval rule"
                    : "Approval history retained",
                status:
                  status === "paused"
                    ? "paused"
                    : stopped
                      ? status
                      : status === "running"
                        ? "not_run"
                        : "succeeded",
                fields: [],
              },
              {
                id: "send",
                title: "Send through Gmail",
                description:
                  status === "uncertain"
                    ? "Check the recorded receipt before any new send."
                    : "Reviewed follow-up",
                status:
                  status === "succeeded"
                    ? "succeeded"
                    : status === "uncertain"
                      ? "uncertain"
                      : "not_run",
                fields: [],
              },
            ],
      effects:
        status === "uncertain"
          ? [
              {
                id: `effect-${n}`,
                label: "Email send",
                status: "unknown",
                description:
                  "Dispatch started, but confirmation was not received. No retry has been made.",
              },
            ]
          : stopped
            ? [
                {
                  id: `effect-${n}`,
                  label: "Draft saved",
                  status: "succeeded",
                  description:
                    "The draft was saved before this run stopped. Stopping the run did not undo it.",
                },
              ]
            : status === "succeeded"
              ? [
                  {
                    id: `effect-${n}`,
                    label: "Email send",
                    status: "succeeded",
                    description: "The provider acknowledged this message.",
                  },
                ]
              : [],
      waits:
        status === "paused"
          ? [
              {
                id: "wait-review-012",
                stepName: "Review before sending",
                label: "Email approval",
                status: "waiting",
              },
            ]
          : [],
      context: [
        {
          kind: "Goal",
          id: "goal-design-partners",
          label: "Win 10 design partners",
          availability: "available",
        },
        {
          kind: "Memory",
          id: "fact-email-preferences",
          label: "Email preferences",
          availability: n === 1 ? "removed" : "available",
        },
      ],
      inspection: {
        status: n === 1 ? "partial" : "complete",
        note:
          n === 1
            ? "An older memory reference is no longer available. These are the recorded run results."
            : null,
      },
    };
    records.set(runId, run);
  }
  let requests = 0;
  let reads = 0;
  let mode: "normal" | "slow" | "unavailable" | "empty" | "uncertain-command" =
    "normal";
  const delay = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));
  const port: WorkflowRunsPort = {
    async list(cursor) {
      reads++;
      if (mode === "unavailable")
        return { status: "unavailable", reason: "Fixture unavailable" };
      if (mode === "empty") return { status: "empty" };
      const items = [...records.values()].sort(
        (a, b) => b.createdAt - a.createdAt,
      );
      const start = cursor ? Number(cursor) : 0;
      return {
        status: "ready",
        data: {
          items: structuredClone(items.slice(start, start + 12)),
          total: items.length,
          nextCursor: start + 12 < items.length ? String(start + 12) : null,
        },
      };
    },
    async detail(id) {
      reads++;
      // Ignore AbortSignal deliberately to exercise controller late-response guards.
      if (mode === "slow") await delay(id.endsWith("012") ? 800 : 80);
      const run = records.get(id);
      return mode === "empty"
        ? { status: "empty" }
        : mode === "unavailable"
          ? { status: "unavailable", reason: "Fixture unavailable" }
          : run
            ? { status: "ready", data: structuredClone(run) }
            : { status: "empty" };
    },
    async start(request) {
      requests++;
      await delay(320);
      if (mode === "uncertain-command")
        return { status: "uncertain", requestId: request.requestId };
      const n = records.size + 1,
        runId = `meeting-run-${String(n).padStart(3, "0")}`;
      const run: RunDetail = {
        ...structuredClone(records.values().next().value!),
        ...request,
        runId,
        label: `Run ${String(n).padStart(3, "0")}`,
        status: "queued",
        createdAt: Date.now(),
        startedAt: null,
        finishedAt: null,
        summary: "Queued. Work has not started.",
        steps: [],
        effects: [],
        waits: [],
        context: [],
        inspection: { status: "complete", note: null },
      };
      records.set(runId, run);
      return {
        status: "accepted",
        requestId: request.requestId,
        run: structuredClone(run),
      };
    },
  };
  const controller = new WorkflowRunsController(RUN_SCOPE, port);
  return {
    controller,
    records,
    port,
    setMode: (value: typeof mode) => {
      mode = value;
    },
    stats: () => ({ requests, reads }),
  };
}

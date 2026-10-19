import { WorkflowManagementController } from "./controller";
import type {
  ManagedWorkflow,
  ManageCommand,
  ManageResult,
  WorkflowManagementPort,
} from "./model";
export const MANAGEMENT_SCOPE = "management-preview-owner";
export const MANAGEMENT_CAPABILITY = {
  contractVersion: 1,
  capabilities: {
    workflowRemoval: {
      supported: true,
      ready: true,
      enabled: true,
      state: "ready",
      reason: null,
    },
  },
};
export const MANAGEMENT_EXAMPLES = [
  "normal",
  "loading",
  "blocked enable",
  "rejected delete",
  "rejected restore",
  "lost response",
  "expired undo",
  "long list",
  "stale",
  "unavailable",
  "unsupported",
  "empty",
] as const;
export type ManagementExample = (typeof MANAGEMENT_EXAMPLES)[number];
const definitions = [
  [
    "meeting",
    "Meeting follow-ups",
    "Turn meetings into an agreed next step.",
    "Meeting ends",
    "12 min ago",
    "meeting-v3",
  ],
  [
    "inbox",
    "Morning inbox brief",
    "Know what needs your attention.",
    "Every weekday",
    "08:31 today",
    "inbox-v2",
  ],
  [
    "competitor",
    "Competitor watch",
    "Keep up with changes that matter.",
    "Every Tuesday",
    "Fri, 09:00",
    "competitor-v1",
  ],
  [
    "investor",
    "Weekly investor update",
    "Your progress, ready to share.",
    "Not scheduled",
    null,
    "investor-v1",
  ],
] as const;
export function makeManagementFixture(
  example: ManagementExample = "normal",
  delayMs = 0,
) {
  let mode = example,
    calls = 0,
    reads = 0,
    checks = 0;
  const records = new Map<string, ManagedWorkflow>(
    definitions.map(
      ([flowId, name, description, trigger, last, versionId], i) => [
        flowId,
        {
          flowId,
          versionId,
          revision: "1",
          name,
          description,
          trigger,
          activation: i === 3 ? "DISABLED" : "ENABLED",
          publication: i === 3 ? "unpublished" : "published",
          readiness: { state: "ready", reason: null },
          latestRun: last ? { runId: `${flowId}-run`, label: last } : null,
        },
      ],
    ),
  );
  if (mode === "long list")
    for (let i = 1; i <= 32; i++)
      records.set(`long-${i}`, {
        ...records.get("inbox")!,
        flowId: `long-${i}`,
        versionId: `long-${i}-v1`,
        name: `Research ${i}: gather the product and customer context for the weekly cross-team briefing`,
        description:
          "Prepare a concise report with sources and proposed next steps.",
        trigger: "Every weekday after the team’s morning planning meeting",
      });
  if (mode === "blocked enable")
    records.set("investor", {
      ...records.get("investor")!,
      readiness: {
        state: "blocked",
        reason: "Connect Notion before enabling.",
      },
    });
  const tombstones = new Map<
      string,
      { item: ManagedWorkflow; receiptId: string; expiresAt: number }
    >(),
    outcomes = new Map<string, ManageResult>();
  const wait = () =>
    new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  const reply = (
    c: ManageCommand,
    body: Omit<ManageResult, "scopeId" | "flowId" | "requestId" | "action">,
  ): ManageResult =>
    ({
      ...body,
      scopeId: c.scopeId,
      flowId: c.flowId,
      requestId: c.requestId,
      action: c.action,
    }) as ManageResult;
  const rejected = (
    c: ManageCommand,
    message: string,
    current?: ManagedWorkflow,
  ): ManageResult => ({
    ...reply(c, { status: "rejected" } as never),
    status: "rejected",
    message,
    ...(current ? { current: structuredClone(current) } : {}),
  });
  const port: WorkflowManagementPort = {
    async read() {
      reads++;
      await wait();
      if (mode === "empty") return { status: "empty" };
      if (mode === "loading") return { status: "loading" };
      if (mode === "unavailable" || mode === "unsupported")
        return { status: mode, reason: "Fixture" };
      const data = {
        scopeId: MANAGEMENT_SCOPE,
        items: structuredClone([...records.values()]),
      };
      return mode === "stale"
        ? { status: "stale", data, reason: "Fixture" }
        : { status: "ready", data };
    },
    async change(c) {
      calls++;
      await wait();
      if (outcomes.has(c.requestId))
        return structuredClone(outcomes.get(c.requestId)!);
      const item = records.get(c.flowId);
      let result: ManageResult;
      if (c.scopeId !== MANAGEMENT_SCOPE) throw Error("Wrong fixture owner");
      if (c.action === "restore") {
        const t = tombstones.get(c.flowId);
        if (!t || t.receiptId !== c.receiptId || t.expiresAt <= Date.now())
          result = rejected(c, "Undo has expired.");
        else if (mode === "rejected restore")
          result = rejected(
            c,
            "Restoration is temporarily unavailable. Try Undo again.",
          );
        else {
          const restored = {
            ...t.item,
            activation: "DISABLED" as const,
            revision: String(Number(t.item.revision) + 1),
          };
          records.set(c.flowId, restored);
          tombstones.delete(c.flowId);
          result = {
            ...reply(c, { status: "accepted" }),
            status: "accepted",
            item: structuredClone(restored),
          };
        }
      } else if (
        !item ||
        item.revision !== c.expectedRevision ||
        item.versionId !== c.versionId
      )
        result = rejected(
          c,
          "The workflow changed. Review its current status.",
          item,
        );
      else if (c.action === "activation") {
        if (c.activation === "ENABLED" && mode === "blocked enable")
          result = rejected(c, "Connect Notion before enabling.", item);
        else {
          const updated = {
            ...item,
            activation: c.activation!,
            revision: String(Number(item.revision) + 1),
          };
          records.set(c.flowId, updated);
          result = {
            ...reply(c, { status: "accepted" }),
            status: "accepted",
            item: structuredClone(updated),
          };
        }
      } else if (mode === "rejected delete")
        result = rejected(
          c,
          "Deletion was refused. This workflow is unchanged.",
          item,
        );
      else {
        const receiptId = `receipt-${c.requestId}`,
          expiresAt = Date.now() + (mode === "expired undo" ? 1500 : 300000);
        tombstones.set(c.flowId, { item, receiptId, expiresAt });
        records.delete(c.flowId);
        result = {
          ...reply(c, { status: "accepted" }),
          status: "accepted",
          receipt: {
            scopeId: c.scopeId,
            flowId: c.flowId,
            versionId: c.versionId,
            receiptId,
            expiresAt,
          },
        };
      }
      outcomes.set(c.requestId, result);
      if (mode === "lost response")
        throw Error("Fixture response lost after acknowledgement");
      return structuredClone(result);
    },
    async reconcile(c) {
      checks++;
      await wait();
      return structuredClone(
        outcomes.get(c.requestId) ?? reply(c, { status: "pending" }),
      );
    },
  };
  const controller = new WorkflowManagementController(
    MANAGEMENT_SCOPE,
    "fixture",
    port,
  );
  return {
    controller,
    port,
    records,
    outcomes,
    tombstones,
    setMode: (v: ManagementExample) => {
      mode = v;
    },
    stats: () => ({ calls, reads, checks }),
  };
}

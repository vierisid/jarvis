import { OpportunitiesController } from "./controller";
import type {
  ActionReceipt,
  ActionRequest,
  FinishedOpportunity,
  OpportunityCollection,
  OpportunitiesPort,
} from "./model";

export const OPPORTUNITIES_SCOPE = "d22-isolated-preview";
export const OPPORTUNITY_EXAMPLES = [
  "ready",
  "preparing",
  "blocked",
  "registration pending",
  "registration blocked",
  "lost response",
  "refused",
  "stale",
  "loading",
  "empty",
  "unavailable",
  "unsupported",
  "long content",
  "missing preview",
] as const;
export type OpportunityExample = (typeof OPPORTUNITY_EXAMPLES)[number];
export function finishedFixtures(): FinishedOpportunity[] {
  return [
    {
      title: "Competitor watch",
      listObservation: "The same competitor tabs.\nEvery Tuesday.",
      observation: "3 Tuesdays.\nSame 3 sites.",
      observationSource: "Competitor checks",
      goalTitle: "Win 10 design partners",
      rationale: "Better answers to ‘why Jarvis?’",
      output: {
        title: "Weekly competitor brief",
        lines: ["Pricing changes", "Product launches"],
        emphasis: "Angles for your pilot pitch",
      },
      steps: ["Read 3 sites", "Compare", "Write brief", "Save in Jarvis"],
      schedule: "Tuesday 09:00",
      target: "This computer",
    },
    {
      title: "Weekly investor update",
      listObservation: "Your Friday update\nalready has a pattern.",
      observation: "Every Friday.\nSame update.",
      observationSource: "Investor updates",
      goalTitle: "Keep investors informed",
      rationale: "Progress ready to share.",
      output: {
        title: "Weekly investor update",
        lines: ["Metrics + milestones", "Progress since last Friday"],
        emphasis: "What needs support",
      },
      steps: ["Gather metrics", "Summarise", "Review", "Send update"],
      schedule: "Friday",
      target: "Review before sending",
    },
  ].map((d, i) => ({
    ...d,
    canApprove: true,
    blockers: [],
    steps: d.steps.map((title, j) => ({ id: `fixture-node-${i}-${j}`, title })),
    proposal: {
      proposalId: `fixture-proposal-${i}`,
      revision: "revision-1",
      compositionId: `fixture-composition-${i}`,
      state: "ready",
      readiness: { state: "ready", checkedAt: 1_791_374_400_000 },
      workflow: {
        flowId: `fixture-flow-${i}`,
        versionId: `fixture-version-${i}`,
        activation: "DISABLED",
        versionState: "LOCKED",
      },
      goal: {
        goalId: `fixture-goal-${i}`,
        revision: "goal-1",
        rationale: d.rationale,
      },
      evidence: [
        { kind: "observation", id: `fixture-observation-${i}`, revision: "1" },
      ],
      bindings: [
        {
          kind: "target",
          id: "fixture-desktop",
          revision: "1",
          availability: "ready",
        },
      ],
      previewBasis: "illustrative_template",
    },
  }));
}
export function fixtureReceipt(
  request: ActionRequest,
  item: FinishedOpportunity,
): ActionReceipt {
  return {
    receiptId: `fixture-receipt-${request.idempotencyKey}`,
    proposalId: request.proposalId,
    revision: request.revision,
    decision: request.decision,
    workflow:
      request.decision === "dismiss"
        ? null
        : {
            flowId: item.proposal.workflow!.flowId,
            versionId: item.proposal.workflow!.versionId,
            versionDigest: "fixture-digest",
          },
    registration: {
      state: request.decision === "dismiss" ? "not_required" : "registered",
      message: null,
    },
    currentActivation:
      request.decision === "dismiss" ? "not_applicable" : "enabled",
    decidedAt: Date.now(),
    updatedAt: Date.now(),
    nextProposalId: null,
  };
}
export function makeOpportunitiesFixture(
  example: OpportunityExample = "ready",
  delay = 0,
) {
  const records = finishedFixtures(),
    receipts = new Map<string, ActionReceipt>(),
    calls: ActionRequest[] = [];
  let reads = 0,
    recoveries = 0,
    reversed = false;
  const wait = () => new Promise((r) => setTimeout(r, delay));
  if (example === "preparing" || example === "blocked") {
    records[0]!.proposal = {
      ...records[0]!.proposal,
      state: example,
      readiness: {
        state: example === "preparing" ? "unchecked" : "blocked",
        checkedAt: null,
      },
    };
    records[0]!.canApprove = false;
    records[0]!.blockers = [
      example === "preparing"
        ? "Preparing the workflow…"
        : "Connect the required service before enabling this workflow.",
    ];
  }
  if (example === "missing preview") records[0]!.output = null;
  if (example === "long content") {
    records[0]!.title =
      "Competitor research for the European enterprise design-partner programme";
    records[0]!.observation =
      "The same competitor pricing pages and product announcements were reviewed before every enterprise pilot call.";
    records[0]!.output!.lines = [
      "Pricing changes across your three closest enterprise alternatives",
      "Product launches relevant to your next design-partner conversation",
    ];
  }
  const port: OpportunitiesPort = {
    read: async (): Promise<OpportunityCollection> => {
      reads++;
      await wait();
      if (example === "loading" || example === "empty")
        return { status: example };
      if (example === "unavailable" || example === "unsupported")
        return {
          status: example,
          reason: "Prepared opportunities are not available in this example.",
        };
      const data = records.filter((x) => !receipts.has(x.proposal.proposalId));
      if (reversed) data.reverse();
      return example === "stale"
        ? {
            status: "stale",
            data,
            reason: "This snapshot is out of date. Refresh before deciding.",
          }
        : { status: "ready", data };
    },
    act: async (request) => {
      calls.push(request);
      await wait();
      if (example === "refused")
        return {
          state: "refused",
          proposalId: request.proposalId,
          revision: request.revision,
          decision: request.decision,
          reason: "This proposal changed. The decision was not saved.",
        };
      const item = records.find(
        (x) => x.proposal.proposalId === request.proposalId,
      )!;
      const receipt = fixtureReceipt(request, item);
      if (
        request.decision === "approve" &&
        (example === "registration pending" ||
          example === "registration blocked")
      ) {
        receipt.registration = {
          state: example === "registration pending" ? "pending" : "blocked",
          message:
            "Approval saved. The selected device needs attention before registration can finish.",
        };
      }
      receipts.set(request.proposalId, receipt);
      if (example === "lost response")
        throw Error("Illustrative lost acknowledgement");
      return receipt;
    },
    recover: async (request) => {
      recoveries++;
      await wait();
      return receipts.get(request.proposalId) ?? null;
    },
  };
  return {
    controller: new OpportunitiesController(
      "fixture",
      OPPORTUNITIES_SCOPE,
      port,
    ),
    port,
    records,
    calls,
    receipts,
    stats: () => ({ reads, recoveries }),
    reorder: () => {
      reversed = !reversed;
    },
  };
}

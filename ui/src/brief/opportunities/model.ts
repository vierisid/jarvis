import type { BriefPreparedOpportunity } from "../../../../src/brief/contracts";
import type { BriefReadState } from "../contracts";

/** Read-only presentation of one F-09 revision. The provider owns every fact. */
export interface FinishedOpportunity {
  proposal: BriefPreparedOpportunity;
  canApprove: boolean;
  title: string;
  observation: string;
  listObservation?: string;
  observationSource: string;
  goalTitle: string | null;
  output: {
    title: string;
    lines: readonly string[];
    emphasis: string | null;
  } | null;
  steps: readonly { id: string; title: string }[];
  schedule: string | null;
  target: string | null;
  blockers: readonly string[];
}
export type OpportunityCollection = BriefReadState<
  readonly FinishedOpportunity[]
>;
export type Decision = "approve" | "dismiss";
export interface ActionRequest {
  proposalId: string;
  revision: string;
  decision: Decision;
  idempotencyKey: string;
}
/** Structural F-10 receipt, without importing its unmerged backend implementation. */
export interface ActionReceipt {
  receiptId: string;
  proposalId: string;
  revision: string;
  decision: Decision;
  workflow: { flowId: string; versionId: string; versionDigest: string } | null;
  registration: {
    state: "pending" | "registered" | "blocked" | "not_required";
    message: string | null;
  };
  currentActivation:
    "enabled" | "paused" | "changed" | "missing" | "not_applicable";
  decidedAt: number;
  updatedAt: number;
  nextProposalId: string | null;
}
/** Only an authenticated adapter can declare that no decision was committed. */
export interface ActionRefusal {
  state: "refused";
  proposalId: string;
  revision: string;
  decision: Decision;
  reason: string;
}
export interface OpportunitiesPort {
  /** Complete authorized collection, aggregating F-09 pages. Never silently truncate. */
  read(): Promise<OpportunityCollection>;
  /** Persist the request before dispatch. Transport uncertainty must throw. */
  act(request: ActionRequest): Promise<ActionReceipt | ActionRefusal>;
  /** Read the original proposal receipt. Never resend approval during recovery. */
  recover(request: ActionRequest): Promise<ActionReceipt | null>;
}
export const APPROVE_LABEL = "Approve & enable";
export const OPPORTUNITY_MOTION = {
  acknowledge: 520,
  dismiss: 360,
  exit: 160,
  enter: 180,
} as const;
export const activeProposal = (item: FinishedOpportunity) =>
  !["accepted", "dismissed"].includes(item.proposal.state);
export function approvalBlock(item: FinishedOpportunity): string | null {
  const p = item.proposal;
  if (p.state !== "ready" || p.readiness.state !== "ready" || !item.canApprove)
    return (
      item.blockers[0] ||
      (p.state === "preparing"
        ? "Preparing the workflow…"
        : "This proposal is not ready to enable.")
    );
  if (
    !p.proposalId ||
    !p.revision ||
    !p.compositionId ||
    !p.goal?.goalId ||
    !p.goal.revision ||
    !p.goal.rationale.trim() ||
    !p.evidence.length ||
    p.evidence.some((e) => !e.id) ||
    !p.previewBasis ||
    !Number.isFinite(p.readiness.checkedAt) ||
    !p.workflow?.flowId ||
    !p.workflow.versionId ||
    p.workflow.versionState !== "LOCKED" ||
    p.workflow.activation !== "DISABLED" ||
    p.bindings.some((b) => !b.id || !b.revision || b.availability !== "ready")
  )
    return "Refresh this proposal to verify its workflow, goal and connections.";
  return null;
}
export function matchesReceipt(
  request: ActionRequest,
  item: FinishedOpportunity,
  receipt: ActionReceipt | null,
): receipt is ActionReceipt {
  if (
    !receipt ||
    !receipt.receiptId ||
    receipt.proposalId !== request.proposalId ||
    receipt.revision !== request.revision ||
    receipt.decision !== request.decision ||
    !Number.isFinite(receipt.decidedAt) ||
    !Number.isFinite(receipt.updatedAt)
  )
    return false;
  if (request.decision === "dismiss")
    return (
      receipt.registration.state === "not_required" &&
      receipt.currentActivation === "not_applicable"
    );
  return (
    !!receipt.workflow?.versionDigest &&
    receipt.workflow.flowId === item.proposal.workflow?.flowId &&
    receipt.workflow.versionId === item.proposal.workflow?.versionId &&
    ["pending", "registered", "blocked"].includes(receipt.registration.state) &&
    ["enabled", "paused", "changed", "missing"].includes(
      receipt.currentActivation,
    )
  );
}
export function resolvedReceipt(receipt: ActionReceipt): boolean {
  return (
    receipt.decision === "dismiss" ||
    (receipt.registration.state === "registered" &&
      receipt.currentActivation === "enabled")
  );
}
export function receiptMessage(receipt: ActionReceipt): string {
  if (receipt.decision === "dismiss")
    return "Proposal dismissed. No workflow enabled.";
  if (receipt.currentActivation === "paused")
    return "Approval saved. The workflow is now paused.";
  if (
    receipt.currentActivation === "changed" ||
    receipt.currentActivation === "missing"
  )
    return "Approval saved. The reviewed workflow has changed or is no longer available.";
  if (receipt.registration.state === "pending")
    return "Approval saved. Trigger registration is pending.";
  if (receipt.registration.state === "blocked")
    return (
      receipt.registration.message ||
      "Approval saved. Workflow setup needs attention."
    );
  return "Workflow enabled. It will run on its configured trigger.";
}

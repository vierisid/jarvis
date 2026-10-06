import type { BriefDecision } from "../../../../../src/brief/contracts";
import type { BriefViewPort } from "../../contracts";
import { isBriefCapabilityEnabled } from "../../../../../src/brief/capabilities";
import type { ApprovalResult, DecisionOperation } from "../decision-transition/controller";

/** Presentation supplied by F-12. Never parse raw tool arguments to invent a document. */
export interface DecisionPaper {
  decision: BriefDecision;
  title: string;
  summary: string;
  description: string;
  reviewLabel: string;
  document: {
    recipient?: string;
    subject: string;
    paragraphs: readonly string[];
    attention?: string;
  };
  /** Exact server-approved language, e.g. Approve & send versus Approve. */
  actionLabels: Partial<Record<DecisionAction, string>>;
  /** Owner-declared approve semantics for this revision, never inferred from its label.
   * Omitted means execution. Acceptance/permission require explicit matching receipts. */
  approveResult?: ApprovalResult;
  queueCount: number | null;
}
export type DecisionAction = "approve" | "keep_draft" | "reject";
export interface DecisionBinding extends BriefViewPort<DecisionPaper> {
  capabilities?: unknown;
  /** Owner writes, reconciles and refreshes the view. Echo requestId in its receipt.
   * A resolved Promise/approved permission alone never advances the presentation. */
  onAction?: (decision: BriefDecision, action: DecisionAction, requestId?: string) => void | Promise<void>;
  operation?: DecisionOperation;
}
export function decisionView(mode: "live" | "preview", binding?: DecisionBinding): DecisionBinding {
  if (!binding || (mode === "preview" && binding.source !== "fixture") || (mode === "live" && (binding.source !== "live" || !isBriefCapabilityEnabled(binding.capabilities, "decisions")))) {
    return { source: mode === "live" ? "live" : "fixture", state: { status: "unavailable", reason: "Your decisions are not available here yet." } };
  }
  return binding;
}
export function decisionTone(item: DecisionPaper): "attention" | "success" | "error" | "running" {
  const approval = item.decision.approval;
  if (approval?.executionOutcome === "failed" || item.decision.workStatus === "failed") return "error";
  if (approval && approval.status !== "pending") return approval.executionOutcome === "committed" ? "success" : "attention";
  return item.decision.workStatus === "running" ? "running" : approval ? "attention" : "success";
}
export function decisionStatus(item: DecisionPaper): string {
  const approval = item.decision.approval;
  if (approval?.status === "pending") return "Needs your review";
  if (approval?.executionOutcome === "committed") return "Execution confirmed";
  if (approval?.executionOutcome === "failed" || item.decision.workStatus === "failed") return "Needs attention";
  if (approval?.status === "denied") return "Rejected";
  if (approval?.status === "expired") return "Approval expired";
  if (approval) return "Check the outcome";
  return item.decision.workStatus === "running" ? "In progress" : "Next in your stack";
}
export function canAct(binding: DecisionBinding, item: DecisionPaper, action: DecisionAction): boolean {
  const operation = binding.operation;
  return binding.state.status === "ready" && !!binding.onAction && !!item.actionLabels[action]
    && item.decision.actions.includes(action)
    && !(operation?.decisionId === item.decision.decisionId && operation.revision === item.decision.revision)
    && (!item.decision.approval || item.decision.approval.status === "pending");
}

import type { DecisionAction, DecisionBinding, DecisionPaper } from "../hero-paper/model";

export type ApprovalResult = "accepted" | "permission_granted" | "executed";

/** Presentation receipts supplied by the existing operation owner, not a new wire API.
 * confirmed requires the reconciled result of the exact requested operation. Permission
 * alone cannot confirm execution. Echo the attempt, source identity and reviewed revision.
 */
export type DecisionOperation = {
  decisionId: string;
  revision: string;
  requestId?: string;
  state: "pending" | "error" | "conflict" | "unknown";
  message?: string;
} | {
  decisionId: string;
  revision: string;
  requestId: string;
  state: "confirmed";
  action: DecisionAction;
  effect: "committed" | "not_started";
  /** Approve result only. Omission retains the original execution-only contract. */
  result?: ApprovalResult;
};

export const DECISION_TIMING = { confirmation: 380, settlement: 220, arrival: 220 } as const;
export type DecisionPhase = "pending" | "blocked" | "confirmed" | "settling" | "awaiting";
export interface DecisionTransition {
  paper: DecisionPaper;
  action: DecisionAction;
  requestId: string;
  phase: DecisionPhase;
  message: string;
  tone: "attention" | "success" | "error" | "neutral";
}

export function confirmation(action: DecisionAction, result: ApprovalResult = "executed") {
  if (action === "approve") {
    if (result === "accepted") return { label: "Step accepted", message: "Step accepted · Not started", tone: "neutral" as const };
    if (result === "permission_granted") return { label: "Permission granted", message: "Permission granted · Not started", tone: "neutral" as const };
    return { label: "Execution confirmed", message: "Execution confirmed", tone: "success" as const };
  }
  return action === "keep_draft" ? { label: "Draft kept", message: "Draft kept · Nothing sent", tone: "neutral" as const }
    : { label: "Rejected", message: "Rejected · Nothing sent", tone: "error" as const };
}

/** Retains only the outgoing visual object. The owner still owns the queue and next item. */
export function reconcileDecision(current: DecisionTransition, binding: DecisionBinding): DecisionTransition {
  const data = binding.state.status === "ready" || binding.state.status === "stale" ? binding.state.data : null;
  const outcome = data?.decision.decisionId === current.paper.decision.decisionId ? data.decision.approval?.executionOutcome : null;
  const failed = outcome === "failed" || (data?.decision.decisionId === current.paper.decision.decisionId && data.decision.workStatus === "failed");
  if (failed || outcome === "unknown" || outcome === "blocked") {
    const message = failed ? "The action failed. Check the outcome before trying again."
      : "The outcome is not confirmed. Refresh to check it; nothing will be retried automatically.";
    if (current.phase === "blocked" && current.message === message) return current;
    return { ...current, phase: "blocked", message, tone: failed ? "error" : "attention" };
  }
  const operation = binding.operation;
  if (!operation || operation.decisionId !== current.paper.decision.decisionId
    || operation.revision !== current.paper.decision.revision || operation.requestId !== current.requestId) return current;
  if (operation.state === "pending") return current;
  // The owner declares the requested meaning before dispatch, on this reviewed revision.
  // A response cannot downgrade Approve & send into mere acceptance or permission.
  const expectedResult = current.paper.approveResult ?? "executed";
  const expectedEffect = current.action === "approve" && expectedResult === "executed" ? "committed" : "not_started";
  if (operation.state === "confirmed" && operation.action === current.action
    && operation.effect === expectedEffect
    && (current.action === "approve" ? (operation.result ?? "executed") === expectedResult : operation.result === undefined)) {
    if (!["pending", "blocked"].includes(current.phase)) return current;
    return { ...current, phase: "confirmed", ...confirmation(current.action, expectedResult) };
  }
  const message = operation.state === "conflict" ? "This decision changed. Refresh before reviewing it again."
    : operation.state === "error" ? operation.message || "The action failed. Check the outcome before trying again."
      : "The outcome is not confirmed. Refresh to check it; nothing will be retried automatically.";
  if (current.phase === "blocked" && current.message === message) return current;
  return { ...current, phase: "blocked", message, tone: operation.state === "error" ? "error" : "attention" };
}

export function hasNextProjection(current: DecisionTransition, binding: DecisionBinding) {
  return binding.state.status === "empty" || (binding.state.status === "ready"
    && binding.state.data.decision.decisionId !== current.paper.decision.decisionId);
}

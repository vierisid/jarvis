import type { DecisionAction, DecisionBinding, DecisionPaper } from "../hero-paper/model";

/** Presentation receipts supplied by the existing operation owner, not a new wire API.
 * confirmed requires a reconciled canonical write/effect. Permission approval alone is
 * insufficient. Echo the attempt, source identity and reviewed revision without alteration.
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

export function confirmation(action: DecisionAction) {
  return action === "approve" ? { message: "Execution confirmed", tone: "success" as const }
    : action === "keep_draft" ? { message: "Draft kept · Nothing sent", tone: "neutral" as const }
      : { message: "Rejected · Nothing sent", tone: "error" as const };
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
  if (operation.state === "confirmed" && operation.action === current.action
    && operation.effect === (current.action === "approve" ? "committed" : "not_started")) {
    if (!["pending", "blocked"].includes(current.phase)) return current;
    return { ...current, phase: "confirmed", ...confirmation(current.action) };
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

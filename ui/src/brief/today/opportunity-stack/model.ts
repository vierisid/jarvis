import type { BriefPreparedOpportunity } from "../../../../../src/brief/contracts";
import { isBriefCapabilityEnabled } from "../../../../../src/brief/capabilities";
import type { BriefViewPort } from "../../contracts";

/** Copy comes from the prepared snapshot's owner, never from UI inference. */
export interface OpportunityCard {
  proposal: BriefPreparedOpportunity;
  title: string;
  observation: string;
  automation: string;
  goalTitle: string;
  preparationReason?: string;
}
export type OpportunityAction = "approve_enable" | "dismiss";
export interface OpportunityRequest {
  requestId: string;
  proposalId: string;
  revision: string;
  action: OpportunityAction;
  flowId: string | null;
  versionId: string | null;
}
export type OpportunityResult = OpportunityRequest & (
  | { state: "confirmed"; receiptId: string; outcome: "enabled" | "dismissed" }
  | { state: "conflict" | "failed" | "unknown" }
);
/** F-09 supplies snapshots; F-10 owns idempotency, readiness recheck and effects. */
export interface OpportunityBinding extends BriefViewPort<readonly OpportunityCard[]> {
  /** Stable authenticated account/workspace scope. Never reuse between accounts. */
  scopeKey: string;
  capabilities?: unknown;
  onAction?: (request: OpportunityRequest) => Promise<OpportunityResult>;
  /** Optional reconciled outcomes for this mounted view's outstanding request IDs. */
  receipts?: readonly OpportunityResult[];
}
export const OPPORTUNITY_APPROVE_LABEL = "Approve & enable";
export const OPPORTUNITY_TIMING = { acknowledge: 520, dismiss: 360, exit: 160, enter: 180 } as const;

export function opportunityView(mode: "live" | "preview", binding?: OpportunityBinding): OpportunityBinding {
  const source = mode === "live" ? "live" : "fixture";
  if (!binding || !binding.scopeKey || binding.source !== source || (mode === "live" && !isBriefCapabilityEnabled(binding.capabilities, "preparedOpportunities"))) {
    return { source, scopeKey: binding?.scopeKey || "unavailable", state: { status: "unsupported", reason: "Prepared opportunities are not available yet." } };
  }
  if (mode === "live" && !isBriefCapabilityEnabled(binding.capabilities, "opportunityActivation")) return { ...binding, onAction: undefined, receipts: undefined };
  return binding;
}
export function opportunityKey(binding: OpportunityBinding, card: OpportunityCard): string {
  return JSON.stringify([binding.source, binding.scopeKey, card.proposal.proposalId, card.proposal.revision]);
}
export function activationBlock(binding: OpportunityBinding, card: OpportunityCard): string | null {
  const p = card.proposal;
  if (binding.state.status !== "ready") return "Refresh this proposal before enabling it.";
  if (p.state === "accepted") return "Workflow enabled";
  if (p.state === "dismissed") return "Dismissed";
  if (p.state !== "ready" || p.readiness.state !== "ready") return card.preparationReason || (p.state === "preparing" ? "Preparing the workflow…" : "Preparation incomplete. Refresh to check readiness.");
  if (!p.proposalId || !p.revision || !p.compositionId || !p.workflow?.flowId || !p.workflow.versionId || !p.goal?.goalId || !p.goal.revision || !p.goal.rationale.trim() || !p.evidence.length || p.evidence.some(e => !e.id) || !p.previewBasis || !Number.isFinite(p.readiness.checkedAt)) return "Preparation incomplete. A reviewed workflow and goal link are required.";
  if (p.bindings.some(b => !b.id || !b.revision || b.availability !== "ready")) return card.preparationReason || "Required connections or devices are not ready.";
  if (!binding.onAction) return "Enabling prepared workflows is not available yet.";
  return null;
}
export function canDismiss(binding: OpportunityBinding, card: OpportunityCard): boolean {
  return binding.state.status === "ready" && !!binding.onAction && !!card.proposal.proposalId && !!card.proposal.revision && !["accepted", "dismissed"].includes(card.proposal.state);
}
export function matchesRequest(request: OpportunityRequest, result: OpportunityResult | undefined): boolean {
  return !!result && (["requestId", "proposalId", "revision", "action", "flowId", "versionId"] as const).every(k => request[k] === result[k]);
}
export function confirmedResult(request: OpportunityRequest, result?: OpportunityResult): boolean {
  return matchesRequest(request, result) && result?.state === "confirmed" && !!result.receiptId && result.outcome === (request.action === "approve_enable" ? "enabled" : "dismissed");
}
export function resultMessage(result?: OpportunityResult): string {
  if (!result) return "Waiting for confirmation…";
  if (result.state === "conflict") return "This proposal changed. Refresh before reviewing it again.";
  if (result.state === "failed") return "The action could not be completed. Refresh to check its status.";
  return "The outcome is not confirmed. Refresh before trying again.";
}

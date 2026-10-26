import type { BriefEvidenceRef, BriefMeasurement } from "../../../../../src/brief/contracts";
import { isBriefCapabilityEnabled } from "../../../../../src/brief/capabilities";
import { goalValue, type GoalPath } from "../../goals/model";
import { qualifiedProgress } from "../outcomes/model";
import type { BriefReadState, BriefViewPort } from "../../contracts";

/** Optional presentation seam. F-13 owns recommendations/receipts; F-15 owns measurements. */
export interface GoalCardData {
  goalId: string; revision: string; title: string; periodLabel?: string;
  fraction?: number | null;
  progress: BriefMeasurement | null; progressLabel: string; change: BriefMeasurement | null;
  drivers: readonly { goalId: string; title: string; progress: BriefMeasurement | null; fraction?: number | null }[];
}
/** The dashboard summarizes direct key results; Goals retains the full milestone tree. */
export function goalCardData(path: GoalPath): GoalCardData {
  const summarize = (goal: GoalPath["goal"]) => {
    const value = goalValue(goal);
    return { goalId: goal.goalId, title: goal.title, fraction: value.fraction,
      progress: value.kind === "measurement" && value.ordinaryCount ? value.measurement : null };
  };
  return { ...summarize(path.goal), revision: path.goal.revision,
    periodLabel: path.goal.status === "draft" ? "Draft goal · Ready to review" : "Active objective",
    progressLabel: path.goal.measurement?.unit ?? "progress", change: null,
    drivers: path.stages.filter(stage => stage.parentId === path.goal.goalId).map(summarize) };
}
/** Zero is the requested initial display, not a stored measurement or an invented business count. */
export function cardProgress(progress: BriefMeasurement | null, fraction?: number | null) {
  if (qualifiedProgress(progress)) return { value: progress.value, target: progress.target, percent: false };
  const value = typeof fraction === "number" && Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : 0;
  return { value: Math.round(value * 1000) / 10, target: 100, percent: true };
}
export interface GoalRecommendation {
  recommendationId: string; revision: string; goalId: string; goalRevision: string;
  title: string; rationale: string; evidence: readonly BriefEvidenceRef[]; expiresAt: number;
  state: "available" | "accepted" | "blocked" | "expired" | "dismissed";
  reason?: string;
}
export interface GoalAcceptRequest {
  requestId: string; recommendationId: string; revision: string; goalId: string; goalRevision: string;
}
export interface GoalQueueItem { decisionId: string; workItemId: string; title: string }
export type GoalAcceptResult = GoalAcceptRequest & (
  | { state: "confirmed"; receiptId: string; destination: GoalQueueItem }
  | { state: "conflict" | "failed" | "unknown" }
);
export interface GoalCardBinding extends BriefViewPort<GoalCardData> {
  capabilities?: unknown;
  recommendation: BriefReadState<GoalRecommendation>;
  /** Fresh owner projection, never a UI-incremented count or synthetic queue item. */
  queue: BriefReadState<readonly GoalQueueItem[]>;
  onAccept?: (request: GoalAcceptRequest) => Promise<GoalAcceptResult>;
}
export function goalView(mode: "live" | "preview", binding?: GoalCardBinding): GoalCardBinding {
  if (!binding || (mode === "preview" ? binding.source !== "fixture" : binding.source !== "live" || !isBriefCapabilityEnabled(binding.capabilities, "goalMeasurements"))) {
    return { source: mode === "live" ? "live" : "fixture", state: { status: "unavailable", reason: "Your goal is not available yet." },
      recommendation: { status: "unsupported", reason: "Recommendations are not available yet." }, queue: { status: "loading" } };
  }
  if (mode === "live" && (!isBriefCapabilityEnabled(binding.capabilities, "recommendations") || !isBriefCapabilityEnabled(binding.capabilities, "decisions"))) {
    return { ...binding, recommendation: { status: "unsupported", reason: "Recommendations are not available yet." }, onAccept: undefined, queue: { status: "loading" } };
  }
  return binding;
}
export function recommendationBlock(binding: GoalCardBinding, now: number): string | null {
  const goal = binding.state, rec = binding.recommendation;
  if (goal.status !== "ready" || rec.status !== "ready") return "Refresh before adding this step.";
  const data = rec.data;
  if (data.goalId !== goal.data.goalId || data.goalRevision !== goal.data.revision) return "Your goal changed. Refresh this recommendation.";
  if (data.state === "accepted") return "Added to Today";
  if (data.state !== "available") return data.reason || (data.state === "expired" ? "This recommendation expired." : data.state === "dismissed" ? "This recommendation was dismissed." : "This step is not ready yet.");
  if (!Number.isFinite(data.expiresAt) || data.expiresAt <= now) return "This recommendation expired. Refresh for a current next step.";
  if (!data.recommendationId || !data.revision || !data.title.trim() || !data.evidence.length) return "This recommendation needs current evidence.";
  if (!binding.onAccept) return "Adding recommendations is not available yet.";
  return null;
}
export function matchingReceipt(request: GoalAcceptRequest, result: GoalAcceptResult | undefined): boolean {
  return !!result && (["requestId", "recommendationId", "revision", "goalId", "goalRevision"] as const).every(key => request[key] === result[key]);
}
export function queuedDestination(result: GoalAcceptResult, title: string, queue: GoalCardBinding["queue"]): GoalQueueItem | null {
  if (result.state !== "confirmed" || !result.receiptId || queue.status !== "ready") return null;
  const dest = result.destination;
  if (!dest?.decisionId || !dest.workItemId || dest.title !== title) return null;
  const matches = queue.data.filter(item => item.decisionId === dest.decisionId || item.workItemId === dest.workItemId);
  return matches.length === 1 && matches[0]!.decisionId === dest.decisionId && matches[0]!.workItemId === dest.workItemId && matches[0]!.title === title ? matches[0]! : null;
}

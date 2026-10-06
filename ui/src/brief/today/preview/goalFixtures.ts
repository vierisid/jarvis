import type { GoalCardBinding, GoalQueueItem, GoalRecommendation } from "../goal-card/model";
import type { OutcomeBinding, OutcomeSummary } from "../outcomes/model";
import { fixtureMeasurement } from "./outcomeFixtures";
import { samplePaper } from "./fixtures";

export const MAYA_TITLE = "Book Maya’s pilot call.";
export function goalPaper() {
  const paper = samplePaper("invitation", false);
  paper.title = MAYA_TITLE; paper.summary = "Maya’s pilot call\nis ready to arrange.";
  paper.description = "Turn her interest into a pilot call.";
  paper.decision.workItemId = "fixture-work-maya";
  return paper;
}
export function goalFixture(outcomes: OutcomeBinding<OutcomeSummary>, scenario = "ready", queue: readonly GoalQueueItem[] = []): GoalCardBinding {
  const outcome = "data" in outcomes.state ? outcomes.state.data.goal : null;
  const goal = { goalId: outcome?.goalId ?? "fixture-design-partners", revision: "goal-v1", title: outcome?.title ?? "Win 10 design partners",
    periodLabel: "September objective", progress: outcome?.progress ?? null, change: outcome?.change ?? null, progressLabel: "signed",
    drivers: [["Qualified leads",24,30],["Pilot calls",12,20],["Pilots started",8,10]].map(([title,value,target], i) => ({ goalId:`fixture-driver-${i}`,title:String(title),progress:fixtureMeasurement(Number(value),"count",Number(target)) })) };
  const rec: GoalRecommendation = { recommendationId:"fixture-recommendation-maya",revision:"rec-v1",goalId:goal.goalId,goalRevision:goal.revision,title:MAYA_TITLE,
    rationale:"She replied yesterday. Turn her interest into a pilot call.",evidence:[{kind:"source",id:"fixture-maya-reply",revision:"1"}],expiresAt:Date.now()+3600000,state:"available" };
  if (scenario === "expired") rec.expiresAt = 0;
  if (scenario === "blocked") { rec.state = "blocked"; rec.reason = "Her reply needs a fresh review."; }
  if (scenario === "changed-goal") rec.goalRevision = "goal-v0";
  if (scenario === "accepted") rec.state = "accepted";
  if (scenario === "long") { rec.title = "Book the next pilot discussion with Maya and the international design partnership team."; rec.rationale = "She replied with questions about the pilot scope, success criteria and who needs to sign off. Agree one useful next conversation with the people who can make that decision."; }
  const recommendation: GoalCardBinding["recommendation"] = ["loading","empty"].includes(scenario) ? {status:scenario as "loading"|"empty"}
    : ["unavailable","unsupported"].includes(scenario) ? {status:scenario as "unavailable"|"unsupported",reason:"Recommendations are not available yet."}
    : scenario === "stale" ? {status:"stale",data:rec,reason:"Refresh this recommendation."} : {status:"ready",data:rec};
  return {source:"fixture",state:outcomes.state.status === "ready" ? {status:"ready",data:goal} : outcomes.state.status === "stale" ? {status:"stale",data:goal,reason:outcomes.state.reason}
    : outcomes.state, recommendation, queue:{status:"ready",data:queue} };
}

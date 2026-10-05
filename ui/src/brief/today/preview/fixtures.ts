import type { DecisionPaper } from "../hero-paper/model";

/** Isolated review data only. Never imported by a live room/provider. */
export const FOLLOW_UP: DecisionPaper = {
  decision: { decisionId: "fixture-decision-follow-up", revision: "fixture-v1", workItemId: "fixture-work-follow-up", workStatus: "blocked",
    approval: { approvalId: "fixture-approval-alex", status: "pending", executionMode: "workflow", executionOutcome: null },
    workflow: null, run: null, actions: ["approve", "keep_draft", "inspect"] },
  title: "Follow-up draft", summary: "The follow-up is ready.\nOne detail needs your eyes.",
  description: "Your email to Alex is drafted.\nConfirm the pilot date before sending.", reviewLabel: "Review follow-up",
  document: { recipient: "Alex", subject: "Our pilot: next steps", paragraphs: ["Hi Alex,", "Let’s start with meeting follow-ups."],
    attention: "Would Thursday, 17 September work for your pilot kickoff?" },
  actionLabels: { approve: "Approve & send", keep_draft: "Keep draft" }, queueCount: 2,
};
export function samplePaper(kind: string, long: boolean): DecisionPaper {
  const item = structuredClone(FOLLOW_UP);
  if (kind === "queued") item.queueCount = 3;
  if (kind === "invitation") {
    item.decision.decisionId = "fixture-decision-invitation"; item.decision.approval!.approvalId = "fixture-approval-maya";
    item.title = "Pilot invitation"; item.summary = "The next conversation\nis ready to start."; item.description = "Invite Maya to map her first workflow.";
    item.reviewLabel = "Review invitation"; item.document = { recipient: "Maya", subject: "Let’s map your first workflow",
      paragraphs: ["Hi Maya,", "Your follow-up routine sounds like a good place to start. Could we spend 20 minutes on it this week?"] };
  }
  if (kind === "unknown") {
    item.decision.approval!.status = "approved"; item.decision.approval!.executionOutcome = "unknown";
    item.decision.actions = ["inspect"]; item.summary = "The follow-up was approved.\nIts outcome needs a check.";
    item.description = "Sending has not been confirmed.";
  }
  if (long) {
    item.document.subject = "Meeting follow-up: agreeing a pilot scope, success criteria and responsibilities across both teams";
    item.document.paragraphs = [...item.document.paragraphs, ...Array.from({ length: 8 }, (_, i) => `Point ${i + 1}: review the agreed scope with the team before confirming dates or making a commitment. Keep the next step clear and record the decision in the meeting notes.`)];
  }
  return item;
}

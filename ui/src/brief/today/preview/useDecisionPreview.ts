import { useEffect, useRef, useState } from "react";
import type { DecisionBinding, DecisionPaper } from "../hero-paper/model";
import type { DecisionOperation } from "../decision-transition/controller";
import { samplePaper } from "./fixtures";

/** Simulated owner, loaded only by the isolated preview. No requests or durable storage. */
export function useDecisionPreview(scenario: string, long: boolean) {
  const [queue, setQueue] = useState<DecisionPaper[]>(() => samples(scenario, long));
  const [operation, setOperation] = useState<DecisionOperation>();
  const [result, setResult] = useState("confirmed");
  const [generation, setGeneration] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reset = () => {
    if (timer.current) clearTimeout(timer.current);
    setQueue(samples(scenario, long)); setOperation(undefined); setGeneration(g => g + 1);
  };
  useEffect(() => { reset(); return () => { if (timer.current) clearTimeout(timer.current); }; }, [scenario, long]);
  const paper = queue[0];
  const binding: DecisionBinding = { source: "fixture", operation,
    state: scenario === "loading" || scenario === "empty" ? { status: scenario }
      : scenario === "unavailable" ? { status: "unavailable", reason: "We couldn’t load your decisions. Your work is unchanged." }
        : !paper ? { status: "empty" } : scenario === "stale" ? { status: "stale", data: paper, reason: "Refresh before reviewing this decision." }
          : { status: "ready", data: { ...paper, queueCount: queue.length } },
    refresh: () => {
      if (operation?.state === "conflict") setQueue(items => items.map((item, i) => i ? item : { ...item, decision: { ...item.decision, revision: "fixture-v2" },
        document: { ...item.document, attention: "Updated pilot date: Monday, 21 September." } }));
    },
    onAction: (decision, action, requestId) => {
      const identity = { decisionId: decision.decisionId, revision: decision.revision, requestId: requestId! };
      setOperation({ ...identity, state: "pending" });
      timer.current = setTimeout(() => {
        if (result === "confirmed") {
          const approvedResult = paper?.approveResult ?? "executed";
          setOperation({ ...identity, state: "confirmed", action, result: action === "approve" ? approvedResult : undefined,
            effect: action === "approve" && approvedResult === "executed" ? "committed" : "not_started" });
          setQueue(items => items.filter(item => item.decision.decisionId !== decision.decisionId));
        } else if (result === "conflict") {
          setOperation({ ...identity, state: "conflict" });
        } else {
          setQueue(items => items.map(item => item.decision.decisionId !== decision.decisionId ? item : { ...item,
            decision: { ...item.decision, actions: ["inspect"], approval: item.decision.approval ? { ...item.decision.approval,
              status: "approved", executionOutcome: result === "failed" ? "failed" : "unknown" } : null } }));
          setOperation({ ...identity, state: result === "failed" ? "error" : "unknown",
            message: result === "failed" ? "Sending failed. The decision has not been removed." : undefined });
        }
      }, 650);
    },
  };
  return { binding, result, setResult, generation, reset, remount: () => setGeneration(g => g + 1),
    append: () => setQueue(items => items.some(item => item.decision.decisionId === "fixture-decision-invitation") ? items
      : [...items, withReject(samplePaper("invitation", long))]) };
}
function withReject(item: DecisionPaper): DecisionPaper {
  return { ...item, decision: { ...item.decision, actions: [...item.decision.actions, "reject"] }, actionLabels: { ...item.actionLabels, reject: "Reject" } };
}
function samples(scenario: string, long: boolean) {
  const first = withReject(samplePaper(scenario, long));
  if (scenario === "acceptance") {
    first.approveResult = "accepted";
    first.decision = { ...first.decision, approval: null, workStatus: "proposed", actions: ["approve", "reject", "inspect"] };
    first.actionLabels = { approve: "Accept step", reject: "Reject" };
    first.title = "Plan the pilot"; first.summary = "A useful next step\nis ready to accept.";
    first.description = "Accept the proposed work. Nothing starts automatically."; first.reviewLabel = "Review step";
    first.document = { subject: "Agree the pilot scope", paragraphs: ["Confirm the success criteria with Alex before preparing the pilot."] };
  } else if (scenario === "permission") {
    first.approveResult = "permission_granted";
    first.actionLabels = { approve: "Grant permission", reject: "Reject" };
    first.title = "Permission request"; first.summary = "The next operation\nneeds your permission.";
    first.description = "Grant permission to continue. Execution is tracked separately."; first.reviewLabel = "Review permission";
    first.document = { subject: "Allow the reviewed operation", paragraphs: ["This confirms permission only, before the operation starts."] };
  }
  const second = withReject(samplePaper("ready", long));
  second.decision = { ...second.decision, decisionId: "fixture-decision-investor", workItemId: "fixture-work-investor",
    approval: { ...second.decision.approval!, approvalId: "fixture-approval-investor" } };
  second.title = "Investor update"; second.summary = "Your investor update\nis ready to review.";
  second.description = "Share this week’s progress with your investors."; second.reviewLabel = "Review investor update";
  second.document = { recipient: "Investors", subject: "This week at Jarvis", paragraphs: ["Two more design partners joined this week.", "Next, we’re preparing their first workflows."] };
  return scenario === "invitation" || scenario === "unknown" ? [first] : [first, second];
}

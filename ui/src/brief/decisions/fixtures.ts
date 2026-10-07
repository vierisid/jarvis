import { samplePaper } from "../today/preview/fixtures";
import { DecisionsController } from "./controller";
import {
  OUTCOMES,
  decisionId,
  revision,
  type DecisionView,
  type DecisionsPort,
  type DocumentReceipt,
  type DocumentRequest,
} from "./model";
export const DECISION_EXAMPLES = [
  "ready",
  "long",
  "many",
  "calendar",
  "read-only",
  "stale",
  "deferred",
  "uncertain",
  "refused",
  "empty",
  "unavailable",
] as const;
export type DecisionExample = (typeof DECISION_EXAMPLES)[number];
export const DECISIONS_SCOPE = "d23-fixture-workspace";
export function decisionFixture(
  kind = "follow-up",
  long = false,
): DecisionView {
  const paper = samplePaper(kind === "invitation" ? kind : "follow-up", long);
  paper.actionLabels.reject = "Reject";
  paper.approveResult = "permission_granted";
  paper.decision.actions = [
    "approve",
    "keep_draft",
    "reject",
    "edit",
    "inspect",
  ];
  paper.description =
    kind === "invitation"
      ? "Review the invitation."
      : "Confirm the pilot date.";
  paper.document.attention =
    kind === "invitation" ? undefined : "Does [pilot date] work for your team?";
  if (kind !== "invitation")
    paper.document.paragraphs = [
      "Hi Alex,",
      "Thanks for the conversation today. I’m excited to help your team turn repetitive work into workflows you can inspect and trust.",
      "For the pilot, we’ll start with meeting follow-ups and review each draft before sending.",
      ...(long ? paper.document.paragraphs.slice(2) : []),
    ];
  const body = [
    ...paper.document.paragraphs,
    ...(paper.document.attention ? [paper.document.attention] : []),
    "Best,\nVieri",
  ].join("\n\n");
  paper.decision.workflow = {
    flowId: "fixture-meeting-followups",
    versionId: "fixture-version-3",
    versionState: "LOCKED",
    activation: "ENABLED",
  };
  return {
    paper,
    document: {
      kind: "email",
      to: [kind === "invitation" ? "maya@example.test" : "alex@example.test"],
      cc: [],
      bcc: [],
      subject: paper.document.subject,
      body,
    },
    generation: 1,
    editable: true,
    actions: ["save", "approve", "keep_draft", "reject"],
    state: "pending",
    reason: null,
    context: "Meeting follow-ups · Run 012",
    options: [],
  };
}
export function makeDecisionsFixture(
  example: DecisionExample = "ready",
  delay = 160,
) {
  let rows = [
    decisionFixture("follow-up", example === "long"),
    decisionFixture("invitation"),
  ];
  let version = 1,
    stale = example === "stale";
  const receipts = new Map<string, DocumentReceipt>();
  const calls: DocumentRequest[] = [];
  if (example === "many")
    rows = Array.from({ length: 10 }, (_, i) => {
      const row = decisionFixture(i % 2 ? "invitation" : "follow-up");
      row.paper.decision.decisionId += `-${i}`;
      row.paper.decision.approval!.approvalId += `-${i}`;
      row.paper.title = `Follow-up ${i + 1}`;
      return row;
    });
  if (example === "calendar") {
    rows[0]!.document = {
      kind: "calendar",
      title: "Pilot kickoff",
      description: "Agree the pilot scope and owner.",
      start: "2026-10-09T10:00:00+02:00",
      end: "2026-10-09T10:30:00+02:00",
      attendees: ["alex@example.test"],
      location: "Video call",
    };
    rows[0]!.paper.title = "Pilot kickoff";
    rows[0]!.paper.actionLabels.approve = "Approve";
    rows[0]!.options = [
      { label: "Calendar", value: "Work" },
      { label: "Notifications", value: "All attendees" },
    ];
  }
  if (example === "read-only") {
    rows[0]!.document = null;
    rows[0]!.editable = false;
    rows[0]!.actions = [];
    rows[0]!.reason =
      "This document format cannot be edited or approved here. Review it in its source workflow.";
  }
  if (example === "deferred") {
    rows[0]!.state = "deferred";
    rows[0]!.actions = ["save", "reopen", "reject"];
    rows[0]!.paper.decision.approval!.status = "expired";
  }
  const pause = () =>
    new Promise<void>((resolve) => setTimeout(resolve, delay));
  const port: DecisionsPort = {
    async read() {
      await pause();
      if (example === "unavailable")
        return {
          status: "unavailable",
          reason: "Decisions are temporarily unavailable.",
        };
      if (example === "empty" || !rows.length) return { status: "empty" };
      if (stale) {
        stale = false;
        return {
          status: "stale",
          data: structuredClone(rows),
          reason: "This queue needs a fresh read before you can act.",
        };
      }
      return { status: "ready", data: structuredClone(rows) };
    },
    async act(request) {
      calls.push(structuredClone(request));
      await pause();
      const item = rows.find((x) => decisionId(x) === request.decisionId);
      if (!item || revision(item) !== request.revision || example === "refused")
        return {
          state: "refused",
          requestId: request.requestId,
          decisionId: request.decisionId,
          revision: request.revision,
          reason: "The decision changed before it could be saved.",
        };
      const next = structuredClone(item);
      next.paper.decision.revision = `fixture-v${++version}`;
      next.generation = (item.generation || 0) + 1;
      if (request.action === "save" || request.action === "reopen") {
        next.paper.decision.approval!.approvalId += `-revision-${version}`;
        if (request.document) next.document = structuredClone(request.document);
        next.state = "pending";
        next.actions = ["save", "approve", "keep_draft", "reject"];
        next.paper.decision.approval!.status = "pending";
      } else if (request.action === "keep_draft") {
        next.state = "deferred";
        next.actions = ["save", "reopen", "reject"];
        next.paper.decision.approval!.status = "expired";
      } else {
        next.actions = [];
        next.editable = false;
        next.state = request.action === "approve" ? "approved" : "rejected";
        next.paper.decision.approval!.status =
          request.action === "approve" ? "approved" : "denied";
      }
      rows =
        request.action === "approve" || request.action === "reject"
          ? rows.filter((x) => decisionId(x) !== request.decisionId)
          : rows.map((x) => (decisionId(x) === request.decisionId ? next : x));
      const receipt: DocumentReceipt = {
        requestId: request.requestId,
        decisionId: request.decisionId,
        approvalId: next.paper.decision.approval!.approvalId,
        generation: next.generation!,
        revision: revision(next),
        decidedAt: Date.now(),
        outcome: OUTCOMES[request.action],
        executed: false,
      };
      receipts.set(request.requestId, receipt);
      if (example === "uncertain") throw Error("Illustrative lost response");
      return receipt;
    },
    async recover(request) {
      await pause();
      return receipts.get(request.requestId) || null;
    },
  };
  const controller = new DecisionsController(
    "fixture",
    DECISIONS_SCOPE,
    port,
    delay ? 520 : 0,
  );
  return {
    controller,
    port,
    calls,
    rows: () => structuredClone(rows),
    changeRevision: () => {
      rows[0]!.paper.decision.revision = `fixture-v${++version}`;
    },
    reorder: () => {
      rows = [...rows].reverse();
    },
  };
}

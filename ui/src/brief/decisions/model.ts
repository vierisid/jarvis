import type { BriefReadState } from "../contracts";
import type { DecisionPaper } from "../today/hero-paper/model";

/** Structural F-14 projection. The authenticated owner, not this room, projects tool inputs. */
export type DecisionDocument =
  | {
      kind: "email";
      to: string[];
      cc: string[];
      bcc: string[];
      subject: string;
      body: string;
    }
  | {
      kind: "calendar";
      title: string;
      description: string;
      start: string;
      end: string;
      attendees: string[];
      location: string;
    };
export type DocumentAction =
  "save" | "approve" | "keep_draft" | "reopen" | "reject";
export interface DecisionView {
  paper: DecisionPaper;
  document: DecisionDocument | null;
  generation: number | null;
  editable: boolean;
  /** Fresh F-14 document actions, not inferred from approval status or label. */
  actions: readonly DocumentAction[];
  state: string;
  reason: string | null;
  context: string | null;
  /** Read-only calendar options supplied by the adapter; never discarded during editing. */
  options: readonly { label: string; value: string }[];
}
export type DecisionCollection = BriefReadState<readonly DecisionView[]>;
export interface DocumentRequest {
  decisionId: string;
  revision: string;
  requestId: string;
  action: DocumentAction;
  document?: DecisionDocument;
}
export interface DocumentReceipt {
  requestId: string;
  decisionId: string;
  approvalId: string;
  generation: number;
  revision: string;
  decidedAt: number;
  outcome:
    | "revision_saved"
    | "permission_granted"
    | "deferred"
    | "reopened"
    | "rejected";
  executed: false;
}
export interface DocumentRefusal {
  state: "refused";
  requestId: string;
  decisionId: string;
  revision: string;
  reason: string;
}
export interface DecisionsPort {
  /** Aggregate the complete authorized queue. Document/actions/revision must describe the same read. */
  read(): Promise<DecisionCollection>;
  /** Persist request before dispatch; revision checks and authority remain server-owned. */
  act(request: DocumentRequest): Promise<DocumentReceipt | DocumentRefusal>;
  /** Read only, using the ORIGINAL requestId. Never retry a mutation here. */
  recover(request: DocumentRequest): Promise<DocumentReceipt | null>;
}
export const decisionId = (item: DecisionView) =>
  item.paper.decision.decisionId;
export const revision = (item: DecisionView) => item.paper.decision.revision;
export const OUTCOMES = {
  save: "revision_saved",
  approve: "permission_granted",
  keep_draft: "deferred",
  reopen: "reopened",
  reject: "rejected",
} as const;
export function matchesReceipt(
  request: DocumentRequest,
  receipt: DocumentReceipt | null,
): receipt is DocumentReceipt {
  return (
    !!receipt &&
    receipt.requestId === request.requestId &&
    receipt.decisionId === request.decisionId &&
    receipt.outcome === OUTCOMES[request.action] &&
    receipt.executed === false &&
    !!receipt.approvalId &&
    !!receipt.revision &&
    Number.isInteger(receipt.generation) &&
    receipt.generation >= 0 &&
    Number.isFinite(receipt.decidedAt)
  );
}
export function receiptMessage(receipt: DocumentReceipt) {
  return {
    revision_saved: "Draft saved. Review the updated version before approving.",
    permission_granted: "Permission granted. Sending has not been confirmed.",
    deferred: "Draft kept. Nothing sent.",
    reopened: "Draft reopened. Review it before approving.",
    rejected: "Rejected. Nothing sent by this decision.",
  }[receipt.outcome];
}
export function actionLabel(view: DecisionView, action: DocumentAction) {
  if (action === "save") return "Save draft";
  if (action === "reopen") return "Reopen draft";
  return (
    view.paper.actionLabels[action] ||
    (action === "approve"
      ? "Approve"
      : action === "keep_draft"
        ? "Keep draft"
        : "Reject")
  );
}
/** Friendly validation only. F-14 validates the entire typed document again on the server. */
export function documentError(doc: DecisionDocument): string | null {
  const text = Object.values(doc).filter(
    (v): v is string => typeof v === "string",
  );
  if (
    text.some((v) =>
      /[\u0000-\u0008\u000b-\u001f\u007f]|<<<(?:END_)?UNTRUSTED_CONTENT/u.test(
        v,
      ),
    )
  )
    return "Remove unsupported control characters.";
  const addresses =
    doc.kind === "email" ? [doc.to, doc.cc, doc.bcc] : [doc.attendees];
  if (
    addresses.some(
      (a) =>
        a.length > 25 ||
        a.some(
          (v) =>
            v.length > 254 ||
            !/^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/u.test(v),
        ),
    ) ||
    (doc.kind === "email" && !doc.to.length)
  )
    return "Enter valid email addresses, separated by commas.";
  if (doc.kind === "email") {
    if (!doc.subject.trim() || !doc.body.trim())
      return "A subject and message are required.";
    if (doc.subject.length > 512 || doc.body.length > 16000)
      return "Shorten the subject or message before saving.";
  } else {
    if (
      !doc.title.trim() ||
      doc.title.length > 512 ||
      doc.location.length > 512 ||
      doc.description.length > 16000
    )
      return "Check the event title, location and description lengths.";
    const validDate = (v: string) => {
      if (
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(
          v,
        ) ||
        !Number.isFinite(Date.parse(v))
      )
        return false;
      const [y, m, d, h, min, s] = v.slice(0, 19).split(/[-T:]/u).map(Number);
      return (
        m! >= 1 &&
        m! <= 12 &&
        d! >= 1 &&
        d! <= new Date(Date.UTC(y!, m!, 0)).getUTCDate() &&
        h! <= 23 &&
        min! <= 59 &&
        s! <= 59
      );
    };
    if (
      !validDate(doc.start) ||
      !validDate(doc.end) ||
      Date.parse(doc.end) <= Date.parse(doc.start)
    )
      return "Use valid ISO dates with timezones and an end after the start.";
  }
  return null;
}
export function fields(
  doc: DecisionDocument,
): { key: string; label: string; value: string; multiline?: boolean }[] {
  return doc.kind === "email"
    ? [
        { key: "to", label: "To", value: doc.to.join(", ") },
        ...(["cc", "bcc"] as const)
          .filter((k) => doc[k].length)
          .map((k) => ({
            key: k,
            label: k === "cc" ? "Cc" : "Bcc",
            value: doc[k].join(", "),
          })),
        { key: "subject", label: "Subject", value: doc.subject },
        { key: "body", label: "Message", value: doc.body, multiline: true },
      ]
    : [
        { key: "title", label: "Event", value: doc.title },
        { key: "start", label: "Starts", value: doc.start },
        { key: "end", label: "Ends", value: doc.end },
        {
          key: "attendees",
          label: "Attendees",
          value: doc.attendees.join(", "),
        },
        { key: "location", label: "Location", value: doc.location },
        {
          key: "description",
          label: "Description",
          value: doc.description,
          multiline: true,
        },
      ];
}

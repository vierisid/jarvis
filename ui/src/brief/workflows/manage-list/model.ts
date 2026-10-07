import type { BriefReadState } from "../../contracts";

/** Presentation seam. The host supplies authorized, complete list snapshots and
 * F-20 durable commands. There is deliberately no adapter to legacy DELETE. */
export interface ManagedWorkflow {
  flowId: string;
  versionId: string | null;
  revision: string;
  name: string;
  description: string;
  trigger: string;
  activation: "ENABLED" | "DISABLED";
  publication: "published" | "unpublished";
  readiness: { state: "ready" | "blocked" | "unknown"; reason: string | null };
  latestRun: { runId: string; label: string } | null;
}
export interface WorkflowList {
  scopeId: string;
  /** Complete ordered collection, not a silent first page of results. */
  items: ManagedWorkflow[];
}
export interface RemovalReceipt {
  scopeId: string;
  flowId: string;
  versionId: string | null;
  receiptId: string;
  expiresAt: number;
}
export interface ManageCommand {
  scopeId: string;
  flowId: string;
  versionId: string | null;
  expectedRevision: string;
  requestId: string;
  action: "activation" | "remove" | "restore";
  activation?: ManagedWorkflow["activation"];
  receiptId?: string;
}
export type ManageResult = Pick<
  ManageCommand,
  "scopeId" | "flowId" | "requestId" | "action"
> &
  (
    | { status: "accepted"; item?: ManagedWorkflow; receipt?: RemovalReceipt }
    | { status: "rejected"; message: string; current?: ManagedWorkflow }
    | { status: "pending" }
  );
export interface WorkflowManagementPort {
  /** Ready is authoritative over settled local commands. Cached snapshots that
   * may predate acknowledged mutations must be marked stale. */
  read(signal: AbortSignal): Promise<BriefReadState<WorkflowList>>;
  /** Persist command identity before dispatch. Rejection means no mutation was
   * committed; transport errors are uncertain. Server owns authorization, CAS,
   * trigger reconciliation, expiry, and same-ID restoration in PAUSED state. */
  change?: (command: Readonly<ManageCommand>) => Promise<ManageResult>;
  /** Read the durable outcome of this exact request. Never submit/replay it. */
  reconcile?: (command: Readonly<ManageCommand>) => Promise<ManageResult>;
}
const text = (s: unknown, max = 4000): s is string =>
  typeof s === "string" && s.length <= max;
const id = (s: unknown): s is string => text(s, 500) && !!s.trim();
const fail = (): never => {
  throw Error("Invalid workflow management projection");
};
export function validateWorkflow(w: ManagedWorkflow): ManagedWorkflow {
  if (
    !w ||
    !id(w.flowId) ||
    !(w.versionId === null || id(w.versionId)) ||
    !id(w.revision) ||
    !text(w.name) ||
    !w.name.trim() ||
    !text(w.description) ||
    !text(w.trigger) ||
    !["ENABLED", "DISABLED"].includes(w.activation) ||
    !["published", "unpublished"].includes(w.publication) ||
    !w.readiness ||
    !["ready", "blocked", "unknown"].includes(w.readiness.state) ||
    !(w.readiness.reason === null || text(w.readiness.reason)) ||
    !(
      w.latestRun === null ||
      (w.latestRun && id(w.latestRun.runId) && text(w.latestRun.label))
    )
  )
    fail();
  return {
    flowId: w.flowId,
    versionId: w.versionId,
    revision: w.revision,
    name: w.name,
    description: w.description,
    trigger: w.trigger,
    activation: w.activation,
    publication: w.publication,
    readiness: { state: w.readiness.state, reason: w.readiness.reason },
    latestRun: w.latestRun
      ? { runId: w.latestRun.runId, label: w.latestRun.label }
      : null,
  };
}
export function validateList(
  list: WorkflowList,
  scopeId: string,
): WorkflowList {
  if (!list || list.scopeId !== scopeId || !Array.isArray(list.items)) fail();
  const items = list.items.map(validateWorkflow);
  if (new Set(items.map((w) => w.flowId)).size !== items.length) fail();
  return { scopeId, items };
}
export function validateResult(
  result: ManageResult,
  command: ManageCommand,
): ManageResult {
  if (
    !result ||
    result.scopeId !== command.scopeId ||
    result.flowId !== command.flowId ||
    result.requestId !== command.requestId ||
    result.action !== command.action
  )
    fail();
  if (result.status === "pending") return result;
  if (result.status === "rejected") {
    if (!text(result.message, 1000) || !result.message.trim()) fail();
    if (
      result.current &&
      validateWorkflow(result.current).flowId !== command.flowId
    )
      fail();
    return result;
  }
  if (result.status !== "accepted") fail();
  if (command.action === "remove") {
    const r = result.receipt;
    if (
      !r ||
      r.scopeId !== command.scopeId ||
      r.flowId !== command.flowId ||
      r.versionId !== command.versionId ||
      !id(r.receiptId) ||
      !Number.isSafeInteger(r.expiresAt) ||
      Math.abs(r.expiresAt) > 8.64e15
    )
      fail();
  } else {
    const w = result.item && validateWorkflow(result.item);
    if (
      !w ||
      w.flowId !== command.flowId ||
      w.versionId !== command.versionId ||
      w.activation !==
        (command.action === "restore" ? "DISABLED" : command.activation)
    )
      fail();
  }
  return result;
}

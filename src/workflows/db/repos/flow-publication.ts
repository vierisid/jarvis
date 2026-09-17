import { getWorkflowDb } from "../index";
import { getFlow, setPublishedVersion, updateFlowStatus, type FlowRow } from "./flow";
import { getFlowVersion, getLatestDraft, lockVersion, type FlowVersion } from "./flow-version";
import { assertFlowVersionOwnership, FlowVersionRequestError } from "./flow-version-ownership";
import { assertCodeStepsAllowed } from "./flow-code-steps";

/**
 * Publish an owned explicit version, or the latest draft. Selection, locking,
 * attachment and enabling commit together. Trigger refresh belongs AFTER this
 * function returns; no asynchronous hooks run inside the database transaction.
 */
export function publishFlowVersion(flowId: string, versionId?: string): { flow: FlowRow; version: FlowVersion } {
  return getWorkflowDb().transaction(() => {
    if (!getFlow(flowId)) throw new FlowVersionRequestError("flow not found", 404);
    if (versionId !== undefined) {
      if (typeof versionId !== "string" || !versionId.trim()) {
        throw new FlowVersionRequestError("versionId must be a non-empty string", 400);
      }
      assertFlowVersionOwnership(flowId, versionId);
    }
    let target = versionId === undefined ? getLatestDraft(flowId) : getFlowVersion(versionId);
    if (!target) throw new FlowVersionRequestError("no draft version to publish", 400);
    // The CODE gate. Publish is the moment a human asked for this flow to
    // start running for real and is waiting on the answer, so a flow carrying
    // a CODE step it was never opted in for is refused HERE -- before the
    // version is locked, before it is attached, before the flow is enabled --
    // rather than per execution, where the refusal would land on a cron tick
    // with nobody reading it.
    assertCodeStepsAllowed(flowId, target.id, "publish");
    if (target.state !== "LOCKED") target = lockVersion(target.id);
    setPublishedVersion(flowId, target.id);
    updateFlowStatus(flowId, "ENABLED");
    return { flow: getFlow(flowId)!, version: target };
  }).immediate();
}

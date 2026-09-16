import { getWorkflowDb } from "../index";
import { getFlow, setPublishedVersion, updateFlowStatus, type FlowRow } from "./flow";
import { getFlowVersion, getLatestDraft, lockVersion, type FlowVersion } from "./flow-version";
import { assertFlowVersionOwnership, FlowVersionRequestError } from "./flow-version-ownership";

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
    if (target.state !== "LOCKED") target = lockVersion(target.id);
    setPublishedVersion(flowId, target.id);
    updateFlowStatus(flowId, "ENABLED");
    return { flow: getFlow(flowId)!, version: target };
  }).immediate();
}

import { getFlowRunInProject } from "../../db/repos/flow-run";
import { getFlowInProject } from "../../db/repos/flow";
import { flowIdOfTriggerHookRunId } from "../../runner/triggers/hook-run-id";
import type { EngineTokenClaims } from "../types";

/**
 * The flow this token's run belongs to, or null when it serves none: a flow
 * run of the token's project, or a trigger hook (poll, enable, disable) of a
 * flow in it.
 */
export function flowOfClaims(claims: EngineTokenClaims): string | null {
  const run = getFlowRunInProject(claims.projectId, claims.runId);
  if (run) return run.flowId;
  const hookFlowId = flowIdOfTriggerHookRunId(claims.runId);
  if (hookFlowId && getFlowInProject(claims.projectId, hookFlowId)) return hookFlowId;
  return null;
}

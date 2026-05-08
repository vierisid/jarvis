/**
 * `/v1/jarvis/workflows/start` -- backs the `jarvis-trigger` piece's
 * `run_workflow` action. Either `flowId` or `flowName` is required;
 * `payload` is optional. Returns `{ runId }`.
 *
 * Workflow lookup + enqueue lives in the daemon (the existing flow repo +
 * job queue). The handler here only validates the envelope.
 */

import { json, err, type RouteContext, type RouteHandler } from "./shared";

export interface WorkflowsStartRequest {
  flowId?: string;
  flowName?: string;
  payload?: Record<string, unknown>;
}

export interface WorkflowsStartResponse {
  runId: string;
}

export type WorkflowsStartFn = (
  req: WorkflowsStartRequest,
  ctx: { runId: string; projectId: string },
) => Promise<WorkflowsStartResponse>;

export interface JarvisWorkflowsRouteDeps {
  workflowsStart?: WorkflowsStartFn;
}

export function createJarvisWorkflowsStartRoute(
  deps: JarvisWorkflowsRouteDeps,
): RouteHandler {
  return async (req: RouteContext) => {
    if (!deps.workflowsStart) {
      return err("jarvis workflows.start not configured", 503);
    }
    let raw: Record<string, unknown>;
    try {
      raw = (await req.json()) as Record<string, unknown>;
    } catch {
      return err("invalid JSON body", 400);
    }
    const out: WorkflowsStartRequest = {};
    if (raw.flowId !== undefined) {
      if (typeof raw.flowId !== "string" || raw.flowId.length === 0) {
        return err("flowId must be a non-empty string if provided", 400);
      }
      out.flowId = raw.flowId;
    }
    if (raw.flowName !== undefined) {
      if (typeof raw.flowName !== "string" || raw.flowName.length === 0) {
        return err("flowName must be a non-empty string if provided", 400);
      }
      out.flowName = raw.flowName;
    }
    if (!out.flowId && !out.flowName) {
      return err("flowId or flowName is required", 400);
    }
    if (raw.payload !== undefined) {
      if (typeof raw.payload !== "object" || raw.payload === null || Array.isArray(raw.payload)) {
        return err("payload must be an object if provided", 400);
      }
      out.payload = raw.payload as Record<string, unknown>;
    }
    const reply = await deps.workflowsStart(out, {
      runId: req.claims.runId,
      projectId: req.claims.projectId,
    });
    return json(reply);
  };
}

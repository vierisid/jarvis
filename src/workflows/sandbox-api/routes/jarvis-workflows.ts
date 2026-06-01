/**
 * `/v1/jarvis/workflows/start` -- backs the `jarvis-trigger` piece's
 * `run_workflow` action. `flowId` is required; `payload` is optional.
 * Returns `{ runId }`.
 *
 * Workflow lookup + enqueue lives in the daemon (the existing flow repo +
 * job queue). The handler here only validates the envelope.
 *
 * Earlier versions of this surface also accepted `flowName` as an
 * alternative resolver. That field was removed when the piece switched
 * to a single `flow` input (an id-only flow_ref) -- the editor's
 * workflow picker writes the id directly, and the LLM composer is told
 * to leave the field empty so the user picks via the UI. No production
 * call site needs name resolution.
 */

import { json, err, parseJsonObject, type RouteContext, type RouteHandler } from "./shared";

export interface WorkflowsStartRequest {
  flowId: string;
  payload?: Record<string, unknown>;
}

export interface WorkflowsStartResponse {
  runId: string;
}

/**
 * Daemon-side workflow-start backend. Implementations must define:
 *
 *   - **flowId resolution**: exact match against `flow.id`. Throws a
 *     `WorkflowRunnerError` with code `FLOW_NOT_FOUND` if absent; the
 *     route maps this to a 404.
 *   - **cycle guard**: refuses the start if the target flow appears
 *     anywhere in the caller's parent-run chain. The route maps the
 *     resulting `SELF_RECURSION` error to a 409.
 *   - **payload**: passed through to RUN_FLOW as the trigger payload.
 *   - **return**: the started run's id; the call is fire-and-forget --
 *     the called workflow runs asynchronously and the caller does not
 *     block on its completion.
 */
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
  return async (ctx: RouteContext) => {
    if (!deps.workflowsStart) {
      return err("jarvis workflows.start not configured", 503);
    }
    const raw = await parseJsonObject(ctx);
    if (raw instanceof Response) return raw;
    if (typeof raw.flowId !== "string" || raw.flowId.length === 0) {
      return err("flowId is required (non-empty string)", 400);
    }
    const out: WorkflowsStartRequest = { flowId: raw.flowId };
    if (raw.payload !== undefined) {
      if (typeof raw.payload !== "object" || raw.payload === null || Array.isArray(raw.payload)) {
        return err("payload must be an object if provided", 400);
      }
      out.payload = raw.payload as Record<string, unknown>;
    }
    try {
      const reply = await deps.workflowsStart(out, {
        runId: ctx.claims.runId,
        projectId: ctx.claims.projectId,
      });
      return json(reply);
    } catch (e) {
      // Typed errors from JarvisWorkflowRunnerAdapter carry a `code`
      // we can map to a specific HTTP status. Anything else falls
      // through to a generic 500 -- preserves the prior behavior for
      // unexpected failures while giving expected user mistakes a
      // crisp status code that the piece's error message can derive
      // from cleanly.
      const code = (e as { code?: unknown }).code;
      if (typeof code === "string") {
        const message = e instanceof Error ? e.message : String(e);
        if (code === "FLOW_NOT_FOUND") return err(message, 404);
        if (code === "SELF_RECURSION") return err(message, 409);
        if (code === "VERSION_MISSING") return err(message, 422);
        if (code === "MISSING_REF") return err(message, 400);
      }
      throw e;
    }
  };
}

/**
 * Adapter: PieceWorkflowRunner over the workflow DB.
 *
 * Resolution rules:
 *   - If `flowId` is given, resolve directly.
 *   - Else if `flowName` is given, search flow_versions by display_name in
 *     the project's flows. Match is case-insensitive exact; no fuzzy match
 *     (workflows the user references by name should resolve unambiguously).
 *
 * Runs are enqueued as RUN_FLOW jobs against the same queue the worker
 * already drains, so this just creates a flow_run row, enqueues, and returns
 * the run id.
 *
 * Errors are thrown as `WorkflowRunnerError` with a `.code` so the calling
 * route can map them to specific HTTP statuses (a stale flow id should be
 * a 404, a self-recursion attempt a 409 -- not the same opaque 500 with
 * raw error text).
 */

import type {
  PieceWorkflowRunner,
  PieceWorkflowStartInput,
  PieceWorkflowStartResult,
} from "../jarvis-pieces/types";
import { getFlow, listFlows } from "../db/repos/flow";
import { getFlowVersion, getLatestDraft } from "../db/repos/flow-version";
import { createFlowRun, getFlowRun } from "../db/repos/flow-run";
import { enqueue } from "../db/repos/job-queue";
import { RUN_FLOW } from "../runner/handler";

export type WorkflowRunnerErrorCode =
  | "MISSING_REF"
  | "FLOW_NOT_FOUND"
  | "VERSION_MISSING"
  | "SELF_RECURSION";

export class WorkflowRunnerError extends Error {
  readonly code: WorkflowRunnerErrorCode;
  constructor(code: WorkflowRunnerErrorCode, message: string) {
    super(message);
    this.name = "WorkflowRunnerError";
    this.code = code;
  }
}

export class JarvisWorkflowRunnerAdapter implements PieceWorkflowRunner {
  /**
   * Start a workflow. When `callerRunId` is supplied, the adapter
   * looks up that run's `flowId` and refuses to start the target if
   * it matches -- direct self-recursion is a classic footgun. Deeper
   * cycles (A -> B -> A) are not caught here; they'd need a parent
   * chain walk and a depth cap, which is a later concern.
   */
  async start(
    input: PieceWorkflowStartInput,
    callerRunId?: string,
  ): Promise<PieceWorkflowStartResult> {
    if (!input.flowId && !input.flowName) {
      throw new WorkflowRunnerError("MISSING_REF", "flowId or flowName is required");
    }
    const flow = input.flowId ? getFlow(input.flowId) : findFlowByName(input.flowName!);
    if (!flow) {
      const ref = input.flowId ?? input.flowName;
      throw new WorkflowRunnerError("FLOW_NOT_FOUND", `flow not found: ${ref}`);
    }
    // Direct self-recursion guard: starting the same flow that's
    // currently executing this `run_workflow` step would loop. The
    // caller has just clicked their own workflow in the picker (or
    // the LLM emitted a self-id) -- refuse rather than fan-out.
    if (callerRunId) {
      const callerRun = getFlowRun(callerRunId);
      if (callerRun && callerRun.flowId === flow.id) {
        throw new WorkflowRunnerError(
          "SELF_RECURSION",
          `refusing to start flow ${flow.id} from itself (would recurse)`,
        );
      }
    }
    const versionId = flow.published_version_id ?? getLatestDraft(flow.id)?.id ?? null;
    if (!versionId) {
      throw new WorkflowRunnerError(
        "VERSION_MISSING",
        `flow ${flow.id} has no published or draft version`,
      );
    }
    if (!getFlowVersion(versionId)) {
      throw new WorkflowRunnerError("VERSION_MISSING", `flow version ${versionId} missing`);
    }
    const run = createFlowRun({
      flowId: flow.id,
      flowVersionId: versionId,
      triggeredBy: "workflow:run_workflow",
      startTime: Date.now(),
    });
    enqueue({
      jobType: RUN_FLOW,
      payload: { runId: run.id, payload: input.payload ?? {} },
      flowRunId: run.id,
      flowId: flow.id,
      flowVersionId: versionId,
      // No auto-retry: a flow with side effects (sending email, hitting an
      // API) would duplicate those effects on retry. The user gets a clear
      // FAILED status and can re-run manually.
      maxAttempts: 1,
    });
    return { runId: run.id };
  }
}

/**
 * Look up a flow by display_name. Display names live on flow_version rows;
 * we walk the project's flows and check the latest draft / published version
 * for a name match.
 */
function findFlowByName(name: string): ReturnType<typeof getFlow> | null {
  const target = name.toLowerCase();
  const flows = listFlows(undefined, { limit: 1000 });
  for (const flow of flows) {
    const versionId = flow.published_version_id ?? getLatestDraft(flow.id)?.id ?? null;
    if (!versionId) continue;
    const version = getFlowVersion(versionId);
    if (version && version.displayName.toLowerCase() === target) {
      return flow;
    }
  }
  return null;
}

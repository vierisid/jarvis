/**
 * Adapter: PieceWorkflowRunner over the workflow DB.
 *
 * `flowId` is the only resolver supported. The route header at
 * `src/workflows/sandbox-api/routes/jarvis-workflows.ts` explains why
 * name-based resolution was dropped; this file is just the
 * implementation.
 *
 * Runs are enqueued as RUN_FLOW jobs against the same queue the worker
 * already drains, so this just creates a flow_run row, enqueues, and
 * returns the run id.
 *
 * Errors are thrown as `WorkflowRunnerError` with a `.code` so the
 * calling route can map them to specific HTTP statuses (a stale flow
 * id should be a 404, a self-recursion attempt a 409 -- not the same
 * opaque 500 with raw error text).
 */

import type {
  PieceWorkflowRunner,
  PieceWorkflowStartInput,
  PieceWorkflowStartResult,
} from "../jarvis-pieces/types";
import { getFlow } from "../db/repos/flow";
import { getFlowVersion, getLatestDraft } from "../db/repos/flow-version";
import { createFlowRun, getFlowRun } from "../db/repos/flow-run";
import { enqueue } from "../db/repos/job-queue";
import { RUN_FLOW } from "../runner/handler";

/**
 * Upper bound on how far up the parent-run chain we walk when checking
 * for cycles. Real workflow nesting users author by hand is shallow
 * (1-3 levels); the bound guards against a malformed DB row that loops
 * on `parent_run_id`, not against legitimate deep nesting.
 */
const MAX_CYCLE_WALK = 64;

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
   * walks the parent-run chain and refuses to start the target if
   * any ancestor is already running it -- catches both direct
   * self-recursion (A -> A) and deeper cycles (A -> B -> A,
   * A -> B -> C -> A, ...).
   */
  async start(
    input: PieceWorkflowStartInput,
    callerRunId?: string,
  ): Promise<PieceWorkflowStartResult> {
    if (!input.flowId) {
      throw new WorkflowRunnerError("MISSING_REF", "flowId is required");
    }
    const flow = getFlow(input.flowId);
    if (!flow) {
      throw new WorkflowRunnerError("FLOW_NOT_FOUND", `flow not found: ${input.flowId}`);
    }
    // Recursion guard: walk the parent-run chain and refuse if ANY
    // ancestor is running the same flow we're about to start. Two
    // bounds protect against a pathological chain:
    //   - MAX_CYCLE_WALK -- absolute depth cap (defends against a
    //     legitimately deep nesting that doesn't include the target).
    //   - `visited` Set    -- breaks on a back-edge (a parent_run_id
    //     pointer that loops without including the target). Without
    //     this we'd waste the full depth budget on every loop; with
    //     it we terminate the first time we revisit any node.
    if (callerRunId) {
      const visited = new Set<string>();
      let cursor: string | null = callerRunId;
      for (let i = 0; cursor && i < MAX_CYCLE_WALK; i++) {
        if (visited.has(cursor)) break;
        visited.add(cursor);
        const ancestor = getFlowRun(cursor);
        if (!ancestor) break;
        if (ancestor.flowId === flow.id) {
          throw new WorkflowRunnerError(
            "SELF_RECURSION",
            i === 0
              ? `refusing to start flow ${flow.id} from itself (would recurse)`
              : `refusing to start flow ${flow.id}: it is already running ${i + 1} level(s) up the call chain (would cycle)`,
          );
        }
        cursor = ancestor.parentRunId;
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
      // Link back to the caller so the recursion guard above can walk
      // the chain on the NEXT run_workflow firing further down the
      // chain. Without this every nested run looks like a top-level
      // run and cycles wouldn't be detectable.
      parentRunId: callerRunId ?? null,
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

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
 */

import type {
  PieceWorkflowRunner,
  PieceWorkflowStartInput,
  PieceWorkflowStartResult,
} from "../jarvis-pieces/types";
import { getFlow, listFlows } from "../db/repos/flow";
import { getFlowVersion, getLatestDraft } from "../db/repos/flow-version";
import { createFlowRun } from "../db/repos/flow-run";
import { enqueue } from "../db/repos/job-queue";
import { RUN_FLOW } from "../runner/handler";

export class JarvisWorkflowRunnerAdapter implements PieceWorkflowRunner {
  async start(input: PieceWorkflowStartInput): Promise<PieceWorkflowStartResult> {
    if (!input.flowId && !input.flowName) {
      throw new Error("workflow runner: flowId or flowName is required");
    }
    const flow = input.flowId ? getFlow(input.flowId) : findFlowByName(input.flowName!);
    if (!flow) {
      const ref = input.flowId ?? input.flowName;
      throw new Error(`workflow runner: flow not found: ${ref}`);
    }
    const versionId = flow.published_version_id ?? getLatestDraft(flow.id)?.id ?? null;
    if (!versionId) {
      throw new Error(`workflow runner: flow ${flow.id} has no published or draft version`);
    }
    if (!getFlowVersion(versionId)) {
      throw new Error(`workflow runner: flow version ${versionId} missing`);
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

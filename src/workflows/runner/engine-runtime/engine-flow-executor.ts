/**
 * `EngineFlowExecutor` -- the production `FlowExecutor` implementation.
 *
 * Replaces the legacy `JarvisPiecesFlowExecutor` (deleted in K3). Each
 * RUN_FLOW job spawns a fresh engine subprocess, sends EXECUTE_FLOW, and
 * awaits the engine's terminal status (uploaded back via WorkerContract).
 *
 * The engine writes the flow_run row directly via `uploadRunLog` -- by the
 * time `executeFlow` resolves, the row reflects the engine's notion of the
 * run's final state (SUCCEEDED / FAILED / INTERNAL_ERROR / TIMEOUT). This
 * executor reads the row back to surface `{steps, stepsCount}` for the
 * worker handler's bookkeeping.
 *
 * `executeTrigger` from the job payload is forwarded to the engine so
 * cron-fired engine-managed triggers run the trigger's `run()` to derive
 * the actual payload(s).
 */

import type {
  FlowExecutor,
  FlowExecutorContext,
  FlowExecutorResult,
} from "../handler";
import { FlowExecutionError } from "../handler";
import { getFlowRun } from "../../db/repos/flow-run";
import { DEFAULT_IDS } from "../../db/schema";
import type { EngineRuntime } from "./engine-runtime";

export class EngineFlowExecutor implements FlowExecutor {
  constructor(private readonly runtime: EngineRuntime) {}

  async execute(ctx: FlowExecutorContext): Promise<FlowExecutorResult> {
    const handle = await this.runtime.acquire({
      runId: ctx.run.id,
      projectId: ctx.run.projectId ?? DEFAULT_IDS.project,
    });
    try {
      await handle.executeFlow({
        flowVersion: ctx.version,
        triggerPayload: ctx.payload,
        executeTrigger: ctx.job.payload.executeTrigger ?? false,
      });
    } finally {
      await handle.release();
    }

    // The engine wrote the run row before its operation reply settled. Read
    // back to surface step output for the handler's bookkeeping.
    const persisted = getFlowRun(ctx.run.id);
    if (!persisted) {
      throw new Error(`flow_run ${ctx.run.id} disappeared after engine executeFlow`);
    }

    const stepsRecord = (persisted.steps ?? {}) as Record<string, unknown>;
    const stepsCount =
      typeof persisted.stepsCount === "number" ? persisted.stepsCount : Object.keys(stepsRecord).length;

    if (persisted.status === "FAILED" || persisted.status === "INTERNAL_ERROR") {
      const failed = persisted.failedStep ?? { name: "unknown", displayName: "unknown" };
      throw new FlowExecutionError(
        `engine executor: run ${ctx.run.id} ended ${persisted.status}`,
        failed,
        stepsRecord,
      );
    }

    return { steps: stepsRecord, stepsCount };
  }
}

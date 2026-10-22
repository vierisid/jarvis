import { withExecutionScope } from "../../actions/execution-scope";
import { withRunOwner } from "../../actions/run-owner-scope";
import { getWorkflowDb } from "../db";
import { getRunCancellation } from "../db/repos/run-cancellation";
import { turnedOffReason } from "../db/repos/flow-turn-off";
import { onRunCanceled, onRunEnded } from "./cancellation-signals";
import { WorkflowCancellationError } from "./cancellation-error";

// Defined in a leaf module and re-exported here, so `ToolRegistry.execute` can
// recognise it without importing the workflow database (see
// cancellation-error.ts). This file stays the name every existing caller uses.
export { WorkflowCancellationError } from "./cancellation-error";

export function assertRunNotCanceled(runId: string): void {
  // Deleting a workflow cascades to its run and cancellation record. Pending
  // daemon callbacks outlive that deletion, so missing identity must also
  // keep their dispatch fence closed. Run IDs are never reused.
  if (getRunCancellation(runId) || !getWorkflowDb().query("SELECT id FROM flow_run WHERE id = ?").get(runId)) {
    throw new WorkflowCancellationError(runId);
  }
}

/**
 * Where a run stands for the tasks it starts (#1018): `stopped` when it was
 * stopped or no longer exists (the fence `assertRunNotCanceled` closes), or
 * when it is still live and its workflow was turned off since it began
 * (turning a workflow off lets an executing run finish, Q-06, but nothing new
 * starts for it); `ended` when it finished on its own; `live` otherwise.
 */
function runState(runId: string): "stopped" | "ended" | "live" {
  if (getRunCancellation(runId)) return "stopped";
  const row = getWorkflowDb().query<{ status: string }, [string]>("SELECT status FROM flow_run WHERE id = ?").get(runId);
  if (!row) return "stopped";
  if (!["QUEUED", "RUNNING", "PAUSED"].includes(row.status)) return "ended";
  return turnedOffReason(runId) !== null ? "stopped" : "live";
}

/**
 * Run `execute` for the run `runId`: its dispatches are fenced by the run's
 * cancellation, and a background task it starts belongs to the run (#1018,
 * `actions/run-owner-scope.ts`), so stopping the run cancels that task too.
 */
export function withRunCancellation<T>(runId: string, execute: () => T): T {
  return withRunOwner({ runId, stopped: () => runState(runId) === "stopped", ended: () => runState(runId) === "ended",
    onStopped: (listener) => onRunCanceled(runId, listener), onEnded: (listener) => onRunEnded(runId, listener) },
    () => withExecutionScope(() => assertRunNotCanceled(runId), execute));
}

export function cancellableWorkflowService<P, C extends { runId: string }, R>(service: (req: P, ctx: C) => Promise<R>): (req: P, ctx: C) => Promise<R> {
  return async (req, ctx) => withRunCancellation(ctx.runId, () => {
    assertRunNotCanceled(ctx.runId);
    return service(req, ctx);
  });
}

export function watchRunCancellation(runId: string): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const cancel = () => controller.abort(new WorkflowCancellationError(runId));
  const dispose = onRunCanceled(runId, cancel);
  if (getRunCancellation(runId)) cancel();
  return { signal: controller.signal, dispose };
}

/** Stop waiting without discarding the underlying operation's eventual receipt. */
export async function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  let listener!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    listener = () => reject(signal.reason);
    signal.addEventListener("abort", listener, { once: true });
    if (signal.aborted) listener();
  });
  try { return await Promise.race([operation, aborted]); }
  finally { signal.removeEventListener("abort", listener); }
}

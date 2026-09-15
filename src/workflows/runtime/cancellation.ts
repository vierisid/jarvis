import { withExecutionScope } from "../../actions/execution-scope";
import { getWorkflowDb } from "../db";
import { getRunCancellation } from "../db/repos/run-cancellation";
import { onRunCanceled } from "./cancellation-signals";

export class WorkflowCancellationError extends Error {
  override readonly name = "WorkflowCancellationError";
  constructor(runId: string) { super(`Workflow ${runId} was canceled or deleted; no new actions may start. Previously dispatched effects may have completed.`); }
}

export function assertRunNotCanceled(runId: string): void {
  // Deleting a workflow cascades to its run and cancellation record. Pending
  // daemon callbacks outlive that deletion, so missing identity must also
  // keep their dispatch fence closed. Run IDs are never reused.
  if (getRunCancellation(runId) || !getWorkflowDb().query("SELECT id FROM flow_run WHERE id = ?").get(runId)) {
    throw new WorkflowCancellationError(runId);
  }
}

export function withRunCancellation<T>(runId: string, execute: () => T): T {
  return withExecutionScope(() => assertRunNotCanceled(runId), execute);
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

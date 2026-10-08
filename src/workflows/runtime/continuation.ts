/**
 * Q-06: a paused run continues exactly once per pause, from the waitpoint
 * that pause is waiting on.
 *
 * Every continuation path (a due timer, a resolved approval, a POST to a
 * resume URL) goes through `claimContinuation`: the waitpoint is consumed, the
 * RESUME job is queued naming that waitpoint, and the continuation is recorded
 * in the trigger ledger, in one transaction. Two guards stop a continuation
 * from waking the wrong pause:
 *  - while one continuation of a run is queued or running, another is not
 *    queued behind it;
 *  - a timer or approval waitpoint whose own step has already finished (the
 *    run was woken early by something else) is retired, never used to wake
 *    whatever the run paused on next.
 * The RUN_FLOW handler checks the same again when the job is claimed
 * (`continuationRefusal`), and a run of a workflow turned off since it began
 * never continues (repos/flow-turn-off.ts). While Jarvis is paused or stopped
 * nothing continues at all (Q-08, runtime/emergency-hold.ts).
 */
import { createHash } from "node:crypto";
import { getWorkflowDb } from "../db/index";
import { getFlowRun, type FlowRun } from "../db/repos/flow-run";
import { enqueue } from "../db/repos/job-queue";
import { getWaitpoint, markWaitpointResumed, type Waitpoint } from "../db/repos/waitpoint";
import { claimFire, fireDigest, recordFire } from "../db/repos/trigger-fire";
import { emergencyHold } from "./emergency-hold";

/** Digest of a version's graph: a draft edited while a run of it was paused no longer matches. */
export function graphDigest(trigger: unknown): string {
  const canonical = JSON.stringify(trigger, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, (item as Record<string, unknown>)[key]])) : item);
  return createHash("sha256").update(canonical ?? "null").digest("hex").slice(0, 32);
}

/**
 * Whether the run's step `stepName` is the one paused: true when it is found
 * PAUSED, false when it is found only in other states (it already finished),
 * undefined when the run's steps do not show it. Steps are recorded wrapped
 * (`{ name: { output: { status } } }`) and, inside loops, raw.
 */
export function stepIsPaused(steps: unknown, stepName: string): boolean | undefined {
  let found = false;
  let paused = false;
  let visits = 0;
  const visit = (value: unknown): void => {
    if (paused || ++visits > 20_000 || !value || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const item of value) visit(item); return; }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === stepName && child && typeof child === "object") {
        const record = child as Record<string, unknown>;
        const inner = record.output && typeof record.output === "object" ? (record.output as Record<string, unknown>) : undefined;
        const status = typeof inner?.status === "string" ? inner.status : typeof record.status === "string" ? record.status : undefined;
        if (status) {
          found = true;
          if (status === "PAUSED") paused = true;
        }
      }
      visit(child);
    }
  };
  visit(steps);
  return paused ? true : found ? false : undefined;
}

/** A continuation of this run is already queued or running. */
export function activeContinuation(runId: string): boolean {
  return !!getWorkflowDb().query<{ id: string }, [string]>(
    `SELECT id FROM workflow_job WHERE flow_run_id = ? AND job_type = 'RUN_FLOW' AND status IN ('QUEUED', 'RUNNING')
       AND json_extract(payload, '$.executionType') = 'RESUME' LIMIT 1`,
  ).get(runId);
}

/** A timer or approval waitpoint whose step already finished: using it would wake the run's next pause. */
function stale(run: FlowRun, waitpoint: Waitpoint): boolean {
  return waitpoint.type !== "WEBHOOK" && stepIsPaused(run.steps, waitpoint.stepName) === false;
}

export type ContinuationKind = "timer" | "approval" | "webhook" | "hold";
export type ContinuationOutcome =
  /** The waitpoint was consumed and the RESUME job queued. */
  | "resumed"
  /** Another continuation of the run is queued or running; try again later. */
  | "busy"
  /** The waitpoint's step had already finished; the waitpoint was retired. */
  | "stale"
  /** Someone else consumed the waitpoint first. */
  | "taken"
  /** The run is not paused. */
  | "not-paused"
  /** Jarvis is paused or stopped: nothing continues; the waitpoint is kept for Resume (Q-08). */
  | "held";

/**
 * Claim one continuation of a paused run. Call outside any transaction.
 * Synchronous: nothing changes the run between the checks and the claim.
 */
export function claimContinuation(input: {
  runId: string;
  waitpoint: Waitpoint;
  kind: ContinuationKind;
  resumePayload: Record<string, unknown>;
  now?: number;
}): ContinuationOutcome {
  const now = input.now ?? Date.now();
  const { runId, waitpoint } = input;
  if (emergencyHold()) return "held";
  const run = getFlowRun(runId);
  if (!run || run.status !== "PAUSED") return "not-paused";
  if (activeContinuation(runId)) return "busy";
  const dedupeKey = `waitpoint:${fireDigest(waitpoint.id)}`;
  if (stale(run, waitpoint)) {
    if (markWaitpointResumed(waitpoint.id, now)) {
      recordFire({ flowId: run.flowId, flowVersionId: run.flowVersionId, source: "resume", dedupeKey, outcome: "skipped",
        runId, detail: { kind: input.kind, reason: "The step this was waiting for had already finished, so it did not wake the run." } });
    }
    return "stale";
  }
  const due = waitpoint.resumeDateTime ? Date.parse(waitpoint.resumeDateTime) : NaN;
  const scheduledFor = Number.isFinite(due) ? due : null;
  let outcome: ContinuationOutcome = "resumed";
  const claimed = claimFire({
    flowId: run.flowId, flowVersionId: run.flowVersionId, source: "resume", dedupeKey, observedAt: now,
    scheduledFor, lateMs: scheduledFor !== null ? Math.max(0, now - scheduledFor) : null, detail: { kind: input.kind },
  }, () => {
    // The claim itself: only one consumer of a waitpoint ever gets here.
    if (!markWaitpointResumed(waitpoint.id, now)) { outcome = "taken"; return { blocked: "This waitpoint was already used.", keepKey: true }; }
    enqueue({
      jobType: "RUN_FLOW",
      payload: { runId, executionType: "RESUME", waitpointId: waitpoint.id, resumePayload: input.resumePayload },
      flowRunId: runId,
      // Re-resuming an already-resumed waitpoint would walk past it.
      maxAttempts: 1,
    });
    return { runId };
  });
  if (claimed.outcome === "duplicate") return "taken";
  return claimed.outcome === "started" ? "resumed" : outcome;
}

/**
 * Release every step parked while Jarvis was paused (HOLD waitpoints). Called
 * when Jarvis is resumed, and on every timer tick so a release survives a
 * restart. A run with another continuation queued keeps its hold for the next
 * tick. Q-08.
 */
export function releaseEmergencyHolds(now = Date.now()): number {
  if (emergencyHold()) return 0;
  const rows = getWorkflowDb().query<{ id: string; flow_run_id: string }, []>(
    `SELECT w.id, w.flow_run_id FROM waitpoint w JOIN flow_run r ON r.id = w.flow_run_id
      WHERE w.type = 'HOLD' AND w.resumed_at IS NULL AND r.status = 'PAUSED'`,
  ).all();
  let released = 0;
  for (const row of rows) {
    const waitpoint = getWaitpoint(row.id);
    if (waitpoint && claimContinuation({ runId: row.flow_run_id, waitpoint, kind: "hold", resumePayload: {}, now }) === "resumed") released++;
  }
  return released;
}

/**
 * Why the RUN_FLOW handler must not continue this run with this job, or null.
 * A RESUME names the waitpoint it consumed: it must belong to the run, have
 * been consumed, and (for a timer or an approval) still be the paused step's.
 * A job from before this check carries no waitpoint and is let through.
 */
export function continuationRefusal(run: FlowRun, waitpointId: unknown): string | null {
  if (typeof waitpointId !== "string" || !waitpointId) return null;
  const waitpoint = getWaitpoint(waitpointId);
  if (!waitpoint || waitpoint.flowRunId !== run.id) return "its waitpoint does not belong to this run";
  if (waitpoint.resumedAt === null) return "its waitpoint was never consumed";
  if (stale(run, waitpoint)) return "the step its waitpoint was for has already finished";
  return null;
}

import { prepareSubmission, submissionConfig } from '../runtime/form-submission';
import { lacksEmailMessageId, prepareEmailEvent, unclaimedEmailEvent } from '../runtime/event-types';
import { gmailAttachmentKey, isGmailAttachmentTrigger } from '../runtime/gmail-attachment';
import { claimAttachmentRun, claimEmailRun, claimSubmissionRun, fireForRun, releaseAttachmentClaim } from '../db/repos/trigger-fire';
import { applyInputOverrides, walkFlowNodes } from '../db/flow-graph';
import { tracksPieceCompletion } from '../runtime/piece-effects';
/**
 * RUN_FLOW worker handler. Bridges the queue to flow execution:
 *   1. Claim a RUN_FLOW job (the worker has already done that for us).
 *   2. Mark the corresponding flow_run as RUNNING.
 *   3. Hand off to a pluggable FlowExecutor that knows how to actually run
 *      the flow definition.
 *   4. Persist the result to the flow_run row (steps, status, finish_time).
 *
 * The FlowExecutor is injected so this file is independent of the engine
 * spawn mechanism. The default `NoopFlowExecutor` does nothing -- it's
 * sufficient to validate the queue/run lifecycle end-to-end and lets the
 * runtime ship before the real engine wiring is done. Phase 3 swaps in a
 * `SubprocessFlowExecutor` that spawns the activepieces engine in
 * SANDBOX_PROCESS mode (per the Phase 2 sandboxing spike).
 */

import type { Job } from "../db/repos/job-queue";
import type { JobHandler } from "../queue/worker";
import { getFlowRun, updateRun, type FlowRun } from "../db/repos/flow-run";
import { cancelFlowRun, getRunCancellation } from "../db/repos/run-cancellation";
import { assertRunIngredientsReady } from "../db/repos/flow-readiness";
import { watchRunCancellation, withRunCancellation } from "../runtime/cancellation";
import { signalRunEnded } from "../runtime/cancellation-signals";
import {
  getFlowVersion,
  mergeRunOutputsIntoSampleData,
  type FlowVersion,
} from "../db/repos/flow-version";

import { workflowFailureMessage } from "../queue/retry-policy";
import { getWorkflowDb } from "../db/index";
import { stopTurnedOffRun, turnedOffReason } from "../db/repos/flow-turn-off";
import { releaseJob } from "../db/repos/job-queue";
import { activeEmergencyState } from "../../authority/emergency";
import { KILLED_RUN_REASON } from "../runtime/emergency-hold";
import { markFireRunStarted, recordFire } from "../db/repos/trigger-fire";
import { continuationRefusal, graphDigest } from "../runtime/continuation";
export { RUN_FLOW } from "../queue/retry-policy";

export interface RunFlowJobPayload {
  runId: string;
  /** Trigger payload / external input. Empty object for manual runs without a payload. */
  payload?: Record<string, unknown>;
  /**
   * When true, the engine first invokes the trigger's `run()` hook and
   * dispatches one flow run per item it returns. Used by engine-managed
   * triggers (e.g. polling triggers fired from cron). The legacy executor
   * ignores this flag; it's honored by the engine-backed executor.
   */
  executeTrigger?: boolean;
  /**
   * "Run from here" / per-step preview: when set, the engine executes only
   * the named step (with step inputs resolved from prior step outputs in
   * `executionState`, which the engine assembles from a sample run if
   * available, else uses the step's `sampleData`). The action's output is
   * captured on `flow_run.steps[stepName]` and the run terminates without
   * walking the rest of the chain. Used by the dashboard's "test step" UI.
   */
  stepNameToTest?: string;
  /**
   * Per-step sample outputs for "test from here" runs. Map
   * `stepName -> sampleOutput`. Forwarded to the engine so it can populate
   * preceding steps' outputs without re-running them. Ignored when
   * `stepNameToTest` is unset (production runs walk the chain for real).
   */
  sampleData?: Record<string, unknown>;
  /**
   * Per-step INPUT override applied only when `stepNameToTest` equals one
   * of the keys. Map `stepName -> input` (a plain object that replaces
   * that step's `settings.input` for the duration of the run). Lets a
   * user exercise a step manually with curated parameters without
   * editing the production-bound input.
   *
   * The route narrows this to one entry per test run (only the step
   * under test), so the engine never accidentally swaps inputs on
   * neighbouring steps.
   */
  sampleInputOverride?: Record<string, Record<string, unknown>>;
  /**
   * `RESUME` wakes a paused run -- the worker handler skips run-row
   * recreation and the executor sends EXECUTE_FLOW with executionType=RESUME
   * + resumePayload + the prior executionState restored from the run's
   * logs file. `BEGIN` (default) starts fresh from the trigger.
   */
  executionType?: "BEGIN" | "RESUME";
  /**
   * The waitpoint a RESUME consumed (Q-06). The handler continues the run only
   * from that waitpoint's pause; a job without one predates the check.
   */
  waitpointId?: string;
  /**
   * Payload delivered to the paused step. Typically the body of the webhook
   * that hit the resume URL, or a timer-fire metadata blob.
   */
  resumePayload?: Record<string, unknown>;
}

export interface FlowExecutorContext {
  /** Aborted after the durable cancellation fence closes. */
  signal?: AbortSignal;
  run: FlowRun;
  version: FlowVersion;
  job: Job<RunFlowJobPayload>;
  /** External payload (e.g., webhook body, manual run input). */
  payload: Record<string, unknown>;
}

export interface FlowExecutorResult {
  /** A pause completes this queue job but leaves the run waiting for a resume. */
  status?: "SUCCEEDED" | "PAUSED";
  /** Per-step output keyed by step name. Empty for trivial flows. */
  steps: Record<string, unknown>;
  stepsCount: number;
}

/** Throw `FlowExecutionError` from an executor when a specific step fails. */
export class FlowExecutionError extends Error {
  override readonly name = "FlowExecutionError";
  constructor(
    message: string,
    public readonly failedStep: { name: string; displayName: string },
    public readonly steps: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export interface FlowExecutor {
  execute(ctx: FlowExecutorContext): Promise<FlowExecutorResult>;
}

/**
 * No-op executor: marks every flow as SUCCEEDED with an empty step record.
 * Used as the default until the real engine spawn lands. Works as a smoke
 * test for the queue + run lifecycle.
 */
export class NoopFlowExecutor implements FlowExecutor {
  async execute(_ctx: FlowExecutorContext): Promise<FlowExecutorResult> {
    return { steps: {}, stepsCount: 0 };
  }
}

export interface CreateRunFlowHandlerOptions {
  executor: FlowExecutor;
  /** Override for tests. Defaults to Date.now. */
  now?: () => number;
  /**
   * Called once a run this handler executed has ended, whatever the outcome,
   * after its final state is written (#1080). A throw is logged, never the run's.
   */
  onRunEnded?: (runId: string) => void;
}

/**
 * Build the JobHandler for the worker dispatcher. Register at:
 *   `new Worker({ handlers: { [RUN_FLOW]: createRunFlowHandler({ executor }) } })`.
 *
 * Lifecycle on each invocation:
 *   - Read the flow_run referenced by the job; abort if missing.
 *   - Read the flow_version referenced by the run; abort if missing.
 *   - Allow BEGIN only for QUEUED runs and RESUME only for PAUSED runs.
 *   - Mark RUNNING and clear the prior pause's failed_step.
 *   - Run the executor.
 *   - On completion: preserve PAUSED, or mark SUCCEEDED with finish_time.
 *   - On FlowExecutionError: mark FAILED with the named failedStep, then
 *     rethrow so the queue records failure. Steps captured before the
 *     failure are persisted.
 *   - On any other Error: mark FAILED with a generic failed_step and rethrow.
 *
 * The shared queue policy forbids automatic workflow retries. A fresh queue
 * job is not permission to replay an already started/terminal run either.
 */
export function createRunFlowHandler(opts: CreateRunFlowHandlerOptions): JobHandler {
  const now = opts.now ?? Date.now;
  return async (job: Job): Promise<void> => {
    const typed = job as unknown as Job<RunFlowJobPayload>;
    const { runId } = typed.payload;
    if (!runId) {
      throw new Error(`RUN_FLOW job ${job.id} missing runId in payload`);
    }
    const run = getFlowRun(runId);
    if (!run) {
      // Stale job referencing a deleted run: do not retry; let the queue mark
      // succeeded and move on. This is rare (only happens if a flow was
      // deleted between enqueue and claim) and self-correcting.
      return;
    }
    // The fence outranks the continuation guard below: a canceled run stops
    // quietly instead of raising a refusal for the STOPPED status the
    // cancellation itself wrote.
    if (getRunCancellation(runId)) return;
    // Pause holds and Kill stops (Q-08). The worker claims nothing while
    // either holds; this covers a job claimed just as it took effect. Paused:
    // the job goes back to the queue untouched. Killed: the run is stopped.
    const emergency = activeEmergencyState();
    if (emergency === "paused") {
      releaseJob(job.id);
      return;
    }
    if (emergency === "killed") {
      if (cancelFlowRun(runId, { reason: KILLED_RUN_REASON, reasonLabel: "Emergency stop" }).accepted) {
        recordFire({ flowId: run.flowId, source: "lifecycle", outcome: "stopped", runId, detail: { reason: KILLED_RUN_REASON } });
      }
      return;
    }
    // A workflow turned off since this run was created never starts or
    // continues it: the run is stopped instead, saying why (Q-06).
    if ((run.status === "QUEUED" || run.status === "PAUSED") && turnedOffReason(runId)) {
      stopTurnedOffRun(run.flowId, runId);
      return;
    }
    const resuming = typed.payload.executionType === "RESUME";
    const expectedStatus = resuming ? "PAUSED" : "QUEUED";
    if (job.attempt !== 1 || run.status !== expectedStatus) {
      throw new Error(workflowFailureMessage(
        `RUN_FLOW refused ${typed.payload.executionType ?? "BEGIN"} for run ${runId} in ${run.status} (attempt ${job.attempt}).`,
      ));
    }
    // A continuation wakes only the pause its waitpoint belongs to; the run
    // stays paused for its own (Q-06).
    const refusal = resuming ? continuationRefusal(run, typed.payload.waitpointId) : null;
    if (refusal) {
      throw new Error(workflowFailureMessage(`RUN_FLOW refused RESUME for run ${runId}: ${refusal}.`));
    }
    const version = getFlowVersion(run.flowVersionId);
    if (!version) {
      const ts = now();
      updateRun(runId, {
        status: "INTERNAL_ERROR",
        failedStep: { name: "<engine>", displayName: "engine" },
        finishTime: ts,
      });
      throw new Error(`RUN_FLOW: flow_version ${run.flowVersionId} not found for run ${runId}`);
    }

    // The graph a run began on is the one it continues on. A draft can be
    // edited while a run of it is paused, and then published as it is; the
    // edited steps never ran their checks for this run, so it is not
    // continued on them (Q-06). A run from before graphs were recorded has
    // no digest and is not compared.
    const digest = graphDigest(version.trigger);
    if (!resuming) {
      getWorkflowDb().run("UPDATE flow_run SET graph_digest = ? WHERE id = ? AND graph_digest IS NULL", [digest, runId]);
    } else {
      const began = getWorkflowDb().query<{ graph_digest: string | null }, [string]>(
        "SELECT graph_digest FROM flow_run WHERE id = ?").get(runId)?.graph_digest;
      if (began && began !== digest) {
        const message = "This workflow's draft was edited while the run was paused, so the run was not continued on the changed steps. Start a new run.";
        updateRun(runId, {
          status: "FAILED",
          failedStep: { name: "<resume>", displayName: "Continue run", errorMessage: message },
          finishTime: now(),
        });
        throw new Error(workflowFailureMessage(`RUN_FLOW refused RESUME for run ${runId}: ${message}`));
      }
    }

    const startTime = run.startTime ?? now();
    updateRun(runId, {
      status: "RUNNING",
      startTime,
      finishTime: null,
      // A planned continuation starts from the paused run's durable state.
      failedStep: null,
    });
    // A run's start time is when it was requested; the delivery that started
    // it also records when it actually began, so a wait in the queue shows as
    // delayed (Q-06). Non-fatal: the ledger is a record, not a gate.
    if (!resuming) {
      try { markFireRunStarted(runId, now()); }
      catch (e) { console.warn(`[run-flow ${runId}] could not record when the run began: ${(e as Error).message}`); }
    }

    const cancellation = watchRunCancellation(runId);
    // Set just before the executor is called: until then no step ran.
    let executing = false;
    try {
      assertRunIngredientsReady(run, version.trigger,
        typed.payload.executionType === 'RESUME' ? undefined : typed.payload);
      let payload = typed.payload.payload ?? {};
      if (version.trigger.settings?.pieceName === 'webhook') {
        const config = submissionConfig(version.trigger.settings.input);
        if (config && !resuming) {
          if (typed.payload.stepNameToTest) throw new FlowExecutionError('Test the complete form workflow with a submission payload; isolated step previews bypass submission validation and are disabled for this flow.', { name: 'trigger', displayName: 'Validate form submission' });
          try {
            const prepared = prepareSubmission(payload, config);
            claimSubmissionRun(run.flowId, version.id, prepared.key, run.id);
            payload = prepared.data;
            if (Object.hasOwn(typed.payload.payload ?? {}, '_webhook')) payload._webhook = typed.payload.payload!._webhook;
          } catch (error) { throw new FlowExecutionError((error as Error).message, { name: 'trigger', displayName: 'Validate form submission' }); }
        }
      }
      const triggerSettings = version.trigger.settings;
      if (!resuming && ['jarvis-trigger', '@jarvispieces/piece-jarvis-trigger'].includes(String(triggerSettings?.pieceName))
        && triggerSettings?.triggerName === 'on_event' && triggerSettings.input?.eventType === 'observer.email_received') {
        try {
          const tested = typed.payload.stepNameToTest;
          // Judged on the graph the preview runs: its input override can turn an
          // untracked step (an HTTP GET) into a tracked one (a POST).
          const overrides = typed.payload.sampleInputOverride;
          const previewed = overrides && Object.keys(overrides).length > 0 ? applyInputOverrides(version.trigger, overrides) : version.trigger;
          const effect = tested ? trackedEffectUnder(previewed, tested) : null;
          if (effect) throw Error(`"${effect}" is a tracked send or change, and a preview of it would act outside this email workflow's once-per-message check. Test the complete workflow with a message payload instead.`);
          // A preview of any other step, or a manual run naming no message,
          // cannot repeat a message: it runs without a claim. A live delivery
          // always carries its message ID; one that does not is refused.
          const live = fireForRun(run.id);
          if (tested || (!(live && (live.source === 'event' || live.source === 'poll')) && lacksEmailMessageId(payload))) {
            payload = unclaimedEmailEvent(payload);
          } else {
            const prepared = prepareEmailEvent(payload);
            claimEmailRun(run.flowId, version.id, prepared.key, run.id);
            payload = prepared.data;
          }
        } catch (error) { throw new FlowExecutionError((error as Error).message, { name: 'trigger', displayName: 'Check Gmail message identity' }); }
      }
      if (!resuming && isGmailAttachmentTrigger(triggerSettings)) {
        try {
          if (typed.payload.stepNameToTest || typed.payload.executeTrigger) throw Error('Test the complete attachment workflow with an emitted attachment payload; isolated step previews and trigger reexecution bypass attachment admission.');
          claimAttachmentRun(run.flowId, version.id, gmailAttachmentKey(payload, run.flowId, run.projectId), run.id);
        } catch (error) { throw new FlowExecutionError((error as Error).message, { name: 'trigger', displayName: 'Check attachment identity' }); }
      }
      executing = true;
      const result = await withRunCancellation(runId, () => opts.executor.execute({
        run,
        version,
        job: typed,
        payload,
        signal: cancellation.signal,
      }));
      updateRun(runId, {
        status: result.status ?? "SUCCEEDED",
        steps: result.steps,
        stepsCount: result.stepsCount,
        finishTime: result.status === "PAUSED" ? null : now(),
      });
      // A run executing when its workflow was turned off is not interrupted,
      // but once it pauses it is stopped rather than left waiting (Q-06).
      if (result.status === "PAUSED" && turnedOffReason(runId)) {
        stopTurnedOffRun(run.flowId, runId);
        return;
      }
      // Sample capture belongs to a run that finished on its own terms:
      // skip a planned continuation, and skip a canceled run whose recorded
      // outcome is the fence's, not the flow's.
      if (result.status === "PAUSED" || getRunCancellation(runId)) return;
      // Auto-capture: write each step's output into the version's
      // sampleData map for cells that are currently empty. Lets the
      // variable picker in the editor surface real field names after a
      // single successful run, without forcing the user to copy/paste
      // step outputs into the sample-data textarea by hand. User-pinned
      // fixtures and LOCKED versions are left untouched -- see
      // `mergeRunOutputsIntoSampleData` for the full skip list.
      try {
        mergeRunOutputsIntoSampleData(run.flowVersionId, result.steps);
      } catch (mergeErr) {
        // Non-fatal: the run already SUCCEEDED. Log and move on.
        console.warn(
          `[run-flow ${runId}] sampleData auto-capture failed: ${(mergeErr as Error).message}`,
        );
      }
    } catch (e) {
      // Deleting the workflow cascades the run away mid-flight. There is no
      // row left to mark FAILED, and retrying would only re-enter the stale-
      // job return above.
      if (!getFlowRun(runId)) return;
      // A fresh run refused before any step held its attachment's content for
      // nothing: release it so a later identical attachment runs once.
      if (!resuming && !executing && isGmailAttachmentTrigger(version.trigger.settings)) {
        try { releaseAttachmentClaim(run.flowId, runId); }
        catch (releaseError) { console.warn(`[run-flow ${runId}] could not release the attachment claim: ${(releaseError as Error).message}`); }
      }
      if (getRunCancellation(runId)) {
        if (e instanceof FlowExecutionError) updateRun(runId, { steps: e.steps });
        return;
      }
      const ts = now();
      // Persist the reason, not just the step. Both branches used to record a
      // bare `{name, displayName}`, so an operator looking at a failed run saw
      // "engine" and nothing else -- the actual message (RPC timeout, engine
      // rejection, ...) lived only in the daemon log.
      const errorMessage = workflowFailureMessage(e instanceof Error ? e.message : String(e));
      if (e instanceof FlowExecutionError) {
        updateRun(runId, {
          status: "FAILED",
          steps: e.steps,
          stepsCount: Object.keys(e.steps).length,
          failedStep: { ...e.failedStep, errorMessage },
          finishTime: ts,
        });
      } else {
        updateRun(runId, {
          status: "FAILED",
          failedStep: { name: "<engine>", displayName: "engine", errorMessage },
          finishTime: ts,
        });
      }
      throw e;
    } finally {
      cancellation.dispose();
      // Never in place of the run's own error: a throw here is only logged.
      try {
        const ended = getFlowRun(runId);
        if (ended && !["QUEUED", "RUNNING", "PAUSED"].includes(ended.status)) {
          // A run that finished on its own releases the background tasks it
          // started (#1018); a stopped one already cancelled them.
          if (ended.status !== "STOPPED") signalRunEnded(runId);
          opts.onRunEnded?.(runId);
        }
      } catch (hookError) { console.error(`[run-flow ${runId}] run-ended hook failed:`, hookError); }
    }
  };
}

/**
 * The tracked effect a step preview would run, or null: the step itself, or
 * one inside a router or loop being previewed (its body runs too, not the
 * steps after it). Tracked effects are the completion-receipt sends and
 * changes plus jarvis-notify; another step may be previewed.
 */
function trackedEffectUnder(trigger: FlowVersion['trigger'], stepName: string): string | null {
  const step = walkFlowNodes(trigger).find(node => node.name === stepName);
  if (!step) return null;
  for (const node of walkFlowNodes({ ...step, nextAction: undefined })) {
    const piece = String(node.settings?.pieceName ?? '');
    const full = piece.startsWith('@') ? piece : piece.startsWith('jarvis-') ? `@jarvispieces/piece-${piece}` : `@activepieces/piece-${piece}`;
    const action = node.settings?.actionName;
    if ((full === '@jarvispieces/piece-jarvis-notify' && action === 'notify') || tracksPieceCompletion(full, action, node.settings?.input)) return node.name;
  }
  return null;
}

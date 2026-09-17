/**
 * The CODE-step gate.
 *
 * A `CODE` step is not a sandboxed expression. The engine writes the step's
 * `sourceCode` bundle to disk and runs it in the engine subprocess, and
 * `AP_EXECUTION_MODE=SANDBOX_PROCESS` is a child process, not an isolate --
 * so that JavaScript has every privilege the daemon's user has: the whole
 * filesystem, the network, the shell. Nothing in the Authority boundary added
 * by #459 / #474 sees it, because it never has to come back through the
 * daemon to do any of that.
 *
 * A flow is also not always hand-authored, which is what makes the privilege
 * matter: `manage_workflow compose` builds a `FlowVersion` out of an LLM plan,
 * and LLM output is untrusted here. So CODE is off by default and turned on
 * PER FLOW, by a human, through `POST /api/workflows/:id/code-steps`.
 *
 * Refusal happens at AUTHORING time, never per execution. That is the lesson
 * from the allowlist that was cut from #459: it refused steps at run time, so
 * a cron- or webhook-triggered flow published perfectly and then failed on
 * every single fire, with nobody watching. Publish is the moment a human is
 * present to read the message, so publish is where this bites -- plus the two
 * other transitions that make a flow runnable without passing publish
 * (enabling it, and asking for a run directly), which are equally synchronous
 * requests with someone on the other end of the reply.
 *
 * Self-contained SQL rather than calls into `flow.ts` / `flow-version.ts`:
 * `flow.updateFlowStatus` calls into here, and a gate that has to be correct
 * is better off without an import cycle.
 */

import { getWorkflowDb } from "../index";
import { findCodeStepNames } from "../flow-graph";
import type { FlowTriggerNode } from "./flow-version";

/** Duck-typed by `jarvis-workflows.ts` to answer 403 instead of 500. */
export const CODE_STEPS_REFUSAL_CODE = "CODE_STEPS_NOT_ENABLED";

/** What the caller was trying to do, so the refusal can name it. */
export type CodeStepIntent = "publish" | "enable" | "run" | "save";

/** Lead sentence, then the clause naming what the grant would unblock. */
const INTENT_TEXT: Record<CodeStepIntent, { lead: string; unblocks: string }> = {
  publish: { lead: "This flow contains", unblocks: "to publish" },
  enable: { lead: "This flow contains", unblocks: "before it can be turned on" },
  run: { lead: "This flow contains", unblocks: "to run it" },
  // A save into the draft an ENABLED flow is already running is a deploy, so
  // it gets its own wording: the flow does not contain the step yet.
  save: { lead: "This edit adds", unblocks: "before saving one into the draft it is running" },
};

/**
 * Names quoted in a refusal before it starts summarizing. A version can carry
 * any number of CODE steps and the message is thrown, logged and shown; six is
 * plenty to identify the problem.
 */
const MAX_NAMED_STEPS = 6;

export class CodeStepsRefusedError extends Error {
  readonly code = CODE_STEPS_REFUSAL_CODE;
  readonly status = 403 as const;
  constructor(
    message: string,
    readonly flowId: string,
    readonly versionId: string,
    readonly stepNames: string[],
  ) {
    super(message);
    this.name = "CodeStepsRefusedError";
  }
}

/**
 * The refusal text. Says what was refused, which step caused it, why the step
 * is privileged, and the exact call that grants the permission -- an error a
 * reader can act on without going to find the source.
 */
function refusalMessage(flowId: string, intent: CodeStepIntent, stepNames: string[]): string {
  const { lead, unblocks } = INTENT_TEXT[intent];
  const plural = stepNames.length > 1;
  const shown = stepNames.slice(0, MAX_NAMED_STEPS).map((name) => `"${name}"`).join(", ");
  const rest = stepNames.length - Math.min(stepNames.length, MAX_NAMED_STEPS);
  const named = rest > 0 ? `${shown} and ${rest} more` : shown;
  return (
    `${lead} ${plural ? `${stepNames.length} CODE steps` : "a CODE step"} (${named}). ` +
    `Enable code steps for this flow ${unblocks}. ` +
    `A CODE step runs arbitrary JavaScript in the workflow engine's child process with this machine's ` +
    `full privileges -- it is a separate process, not an isolate -- so it stays off until it is turned on ` +
    `for this flow: POST /api/workflows/${flowId}/code-steps {"enabled": true}`
  );
}

/** Parse a stored `flow_version.trigger`, or null when it is not readable. */
function parseTrigger(raw: string): FlowTriggerNode | null {
  try {
    return JSON.parse(raw) as FlowTriggerNode;
  } catch {
    return null;
  }
}

/**
 * Refuse `intent` when `versionId` contains a CODE step and `flowId` has not
 * opted in. A missing flow or version is not this gate's business -- the
 * caller has its own not-found handling and gets to report it.
 */
export function assertCodeStepsAllowed(flowId: string, versionId: string, intent: CodeStepIntent): void {
  const db = getWorkflowDb();
  // Three early returns below hand back "allowed" without looking at a graph:
  // a flow that does not exist, a version that does not exist, and a trigger
  // that will not parse. None of them can run a CODE step, and each already
  // fails with a better message in its own caller -- `publishFlowVersion`
  // checks the flow, `getLatestDraft` parses the trigger. The gate is not the
  // right place to re-report somebody else's 404.
  const flow = db
    .query<{ code_steps_enabled: number }, [string]>(`SELECT code_steps_enabled FROM flow WHERE id = ?`)
    .get(flowId);
  if (!flow) return;
  // Opted in: no scan, no cost. This is also why a grandfathered flow keeps
  // working -- the upgrade wrote the flag, so it never reaches the walk.
  if (flow.code_steps_enabled === 1) return;
  // Looked up by id alone. Constraining on `flow_id` too would make a
  // wrong-parent version fail OPEN here, and a gate should never be the thing
  // that shrugs at an inconsistency; parentage is `flow-version-ownership`'s
  // job and it already refuses before anything reaches this point.
  const version = db
    .query<{ trigger: string }, [string]>(`SELECT trigger FROM flow_version WHERE id = ?`)
    .get(versionId);
  if (!version) return;
  const trigger = parseTrigger(version.trigger);
  if (!trigger) return;
  const stepNames = findCodeStepNames(trigger);
  if (stepNames.length === 0) return;
  throw new CodeStepsRefusedError(refusalMessage(flowId, intent, stepNames), flowId, versionId, stepNames);
}

/**
 * Same check against the version this flow would actually run: its published
 * version, or -- because an ENABLED flow with no published version still gets
 * its trigger registered -- its latest draft.
 */
export function assertFlowCodeStepsAllowed(flowId: string, intent: CodeStepIntent): void {
  const target = getWorkflowDb()
    .query<{ version_id: string | null }, [string]>(
      `SELECT COALESCE(f.published_version_id,
                       (SELECT v.id FROM flow_version v
                         WHERE v.flow_id = f.id AND v.state = 'DRAFT'
                         ORDER BY v.updated DESC LIMIT 1)) AS version_id
         FROM flow f WHERE f.id = ?`,
    )
    .get(flowId);
  if (!target?.version_id) return;
  assertCodeStepsAllowed(flowId, target.version_id, intent);
}

/**
 * Gate a trigger graph about to be WRITTEN onto the draft an ENABLED flow is
 * already running.
 *
 * The transition gate on `updateFlowStatus` checks the version that is live at
 * the moment somebody enables the flow -- but a DRAFT row is mutated in place,
 * and `TriggerManager` resolves `published ?? latest draft`, so without this
 * the graph behind a registered cron could acquire a CODE step afterwards and
 * the invariant would quietly stop holding. `createDraftVersion` and
 * `updateDraftVersion` are the only two writers of `flow_version.trigger`, so
 * gating both closes it structurally rather than by enumeration.
 *
 * Only for a flow that is ENABLED with NO published version, which is the one
 * shape where a draft is what actually runs. With a published version the
 * draft is inert until publish, and publish has its own gate -- editing a
 * draft there stays free, which is what keeps this out of the way of ordinary
 * authoring.
 */
export function assertCodeStepsAllowedForLiveDraft(flowId: string, trigger: unknown): void {
  const flow = getWorkflowDb()
    .query<{ status: string; published_version_id: string | null; code_steps_enabled: number }, [string]>(
      `SELECT status, published_version_id, code_steps_enabled FROM flow WHERE id = ?`,
    )
    .get(flowId);
  if (!flow || flow.code_steps_enabled === 1) return;
  if (flow.status !== "ENABLED" || flow.published_version_id !== null) return;
  const stepNames = findCodeStepNames(trigger as FlowTriggerNode);
  if (stepNames.length === 0) return;
  throw new CodeStepsRefusedError(refusalMessage(flowId, "save", stepNames), flowId, "", stepNames);
}

/**
 * CODE steps in `trigger` that this flow has no permission to run, or null
 * when there is nothing to report. Used by `TriggerManager` to decline the
 * subscription instead of registering it.
 *
 * Registration -- at boot, and on refresh after a publish or a status change
 * -- is the last point at which a version becomes autonomously runnable, and
 * it is NOT per execution, so declining here is not the run-time refusal that
 * got #459's allowlist pulled. It is the backstop for the one thing the
 * authoring gates cannot see: which DRAFT is "latest" moves with any write
 * that bumps a draft's `updated`, so a CODE draft that was not live when the
 * flow was enabled can become live later. A published flow always carries the
 * grant (publish requires it, the upgrade grandfathered it), so this can only
 * ever decline a flow that was never publishable in the first place.
 */
export function ungrantedCodeSteps(
  flow: { id: string; code_steps_enabled: number },
  trigger: unknown,
): string[] | null {
  if (flow.code_steps_enabled === 1) return null;
  const stepNames = findCodeStepNames(trigger as FlowTriggerNode);
  return stepNames.length > 0 ? stepNames : null;
}

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
export type CodeStepIntent = "publish" | "enable" | "run";

const INTENT_TEXT: Record<CodeStepIntent, string> = {
  publish: "to publish",
  enable: "before it can be turned on",
  run: "to run it",
};

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
  const plural = stepNames.length > 1;
  const named = stepNames.map((name) => `"${name}"`).join(", ");
  return (
    `This flow contains ${plural ? `${stepNames.length} CODE steps` : "a CODE step"} (${named}). ` +
    `Enable code steps for this flow ${INTENT_TEXT[intent]}. ` +
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

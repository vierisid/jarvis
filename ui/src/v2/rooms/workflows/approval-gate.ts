/**
 * What the dashboard says about steps that run without approval (#955), and,
 * since #961, that HTTP request steps are governed by their method.
 *
 * Only verified pieces and Jarvis's own steps go through Authority. A
 * community piece's actions run without asking, whatever the governed
 * categories say. They are not invisible: the daemon writes an audit row for
 * each dispatch and holds or refuses them on Pause and Kill
 * (`admitUngovernedStep` in src/workflows/runtime/service-backends.ts). The
 * copy says exactly that, and nothing stronger.
 *
 * Which piece is a community piece is the daemon's call
 * (`src/workflows/runtime/step-admission.ts`), sent as `notApprovalGated` on
 * each `/api/workflows/pieces` entry, so the badge cannot drift from the gate.
 */

import type { FlowStepNode, PieceCatalogEntry } from "./useWorkflowEditor";

export const NOT_APPROVAL_GATED_LABEL = "Not approval-gated";

export const NOT_APPROVAL_GATED_TOOLTIP =
  "This community piece runs without approval, even for categories you govern, such as sending email. Each time it runs it is recorded in the audit log, and it is held while Jarvis is paused and refused after Kill.";

export const COMMUNITY_APPROVAL_NOTE =
  "Actions from community pieces run without approval: governed categories such as sending email do not apply to them. Each time one runs it is recorded in the audit log, and it is held while Jarvis is paused and refused after Kill. Verified pieces ask before governed actions.";

export const AUTHORITY_SCOPE_NOTE =
  "Governed categories apply to chat, agents, Jarvis's own workflow pieces, verified workflow pieces and HTTP request steps. An HTTP request is judged by its method: a GET reads, a POST, PUT or PATCH sends a message, and a DELETE deletes. Community pieces and CODE steps in workflows run without approval: each time one runs it is recorded in the audit log, and it is held while Jarvis is paused and refused after Kill. Built-in steps that act only inside the workflow, such as Delay, also run without approval and are not recorded one by one.";

/** An action step whose piece the daemon reports as not approval-gated. Triggers are not covered. */
export function stepNotApprovalGated(step: FlowStepNode, catalog: readonly PieceCatalogEntry[]): boolean {
  if (step.type !== "PIECE" || !step.settings?.pieceName || !step.settings.actionName) return false;
  const piece = catalog.find((p) => p.name === step.settings?.pieceName);
  if (piece?.notApprovalGated === true) return true;
  // A partly governed piece marks only its ungoverned actions.
  return piece?.actions.find((a) => a.name === step.settings?.actionName)?.notApprovalGated === true;
}

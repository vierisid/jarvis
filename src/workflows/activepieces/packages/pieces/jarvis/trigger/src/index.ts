/**
 * `@jarvispieces/piece-jarvis-trigger` -- bridges Jarvis events into workflows
 * and exposes one workflow as the input to another.
 *
 *   trigger: on_event       (polling: subscribe to a Jarvis event type)
 *   action:  run_workflow   (start another saved workflow; the user picks
 *                            the target via the editor's flow_ref widget,
 *                            value stored as the destination flow id)
 *
 * Both surfaces call back to the daemon. The trigger uses a stateless poll
 * pattern (the daemon keeps a short-lived recent-events buffer; the trigger
 * persists its `since` cursor via `context.store`).
 */

import { createPiece, PieceAuth } from "@activepieces/pieces-framework";
import { onEventTrigger } from "./lib/triggers/on-event";
import { runWorkflowAction } from "./lib/actions/run-workflow";

export const jarvisTriggerPiece = createPiece({
  displayName: "Jarvis: Trigger",
  description:
    "Bridge Jarvis events into workflows (on_event trigger) and run saved workflows from inside other workflows (run_workflow action).",
  auth: PieceAuth.None(),
  minimumSupportedRelease: "0.0.0",
  logoUrl: "",
  authors: ["jarvis"],
  actions: [runWorkflowAction],
  triggers: [onEventTrigger],
});

/**
 * `wait_for_signal` action: pauses the flow via a WEBHOOK waitpoint and
 * resumes when the waitpoint's URL is hit. Used by the RESUME end-to-end
 * test to exercise the full pause/zstd-backup/resume cycle without
 * pulling in upstream's approval/delay pieces.
 *
 * Behavior:
 *   - On BEGIN execution: create the waitpoint, surface its resumeUrl in
 *     the returned step output (so the test can grab it from
 *     `flow_run.steps.<step>.output.resumeUrl` and POST), then wait.
 *   - On RESUME execution: return the resumePayload echoed back so the
 *     test can assert end-to-end value plumbing.
 */

import { createAction, Property } from "@activepieces/pieces-framework";
import { ExecutionType } from "@activepieces/shared";

export const waitForSignalAction = createAction({
  name: "wait_for_signal",
  displayName: "Wait for signal (test)",
  description: "Pauses the flow until the waitpoint URL is hit. Test fixture.",
  // The action returns one of two shapes depending on which execution
  // phase we're in: a waitpoint announcement on BEGIN (the run pauses
  // immediately after), or the resume payload on RESUME (what the
  // POST to the resumeUrl carried). Downstream steps only ever see
  // the RESUME shape, so that's what we declare; the BEGIN keys can
  // be referenced manually via `{{step.waitpointId}}` if needed.
  outputSample: {
    resumed: true,
    resumePayload: { ok: true },
    label: "wait-for-approval",
  },
  props: {
    label: Property.ShortText({
      displayName: "Label",
      description: "Echoed back on resume for traceability.",
      required: false,
    }),
  },
  async run(ctx) {
    if (ctx.executionType === ExecutionType.BEGIN) {
      const waitpoint = await ctx.run.createWaitpoint({ type: "WEBHOOK" });
      ctx.run.waitForWaitpoint(waitpoint.id);
      // The engine's pause path discards this return value (the step output
      // gets set to PAUSED), so the return here is mostly belt-and-braces.
      // The waitpoint id is also recorded in the flow_run row's waitpoints
      // surface which the test reads via /api/workflow-runs/:id/waitpoints.
      return {
        waitpointId: waitpoint.id,
        resumeUrl: waitpoint.resumeUrl,
        label: ctx.propsValue["label"] ?? null,
      };
    }
    return {
      resumed: true,
      resumePayload: ctx.resumePayload ?? null,
      label: ctx.propsValue["label"] ?? null,
    };
  },
});

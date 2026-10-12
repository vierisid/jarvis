/**
 * `run_workflow` action -- POST `{ flowId, payload? }` to
 * `/v1/jarvis/workflows/start`. Returns the child run id, optionally parking
 * until the child finishes successfully.
 *
 * Surface: a single `flow` input that holds the target flow's id. The
 * editor renders this as a searchable workflow picker (see the
 * `flow_ref` input type and its catalog projection in
 * `runtime/piece-catalog.ts`). The piece source declares it as
 * ShortText because the upstream piece framework has no flow-ref
 * concept; the catalog promotes the field to `flow_ref` at projection
 * time so the editor knows to render the picker. Same pattern as the
 * on_event eventType enum upgrade.
 *
 * The daemon route at `sandbox-api/routes/jarvis-workflows.ts` is the
 * source of truth for the request envelope and explains the
 * `flowName` removal for readers who want the history.
 */

import { createAction, Property } from "@activepieces/pieces-framework";
import { assertActionSucceeded, type ActionOutcome } from '../../../../../../../../../actions/action-outcome';

interface RunWorkflowResponse {
  runId: string | null;
  waitpointId?: string;
  child?: { outcome?: ActionOutcome };
  approval?: { effectId: string; approvalId: string; waitpointId: string };
}

export const runWorkflowAction = createAction({
  name: "run_workflow",
  displayName: "Run another workflow",
  description:
    "Trigger a saved workflow by id. Optionally wait for its completion and stop this step if the child fails.",
  // The child receipt carries status and identity, not arbitrary child outputs.
  outputSample: {
    runId: "run_01HX...",
  },
  props: {
    flow: Property.ShortText({
      displayName: "Flow",
      description: "Pick a workflow to run.",
      required: true,
    }),
    waitForCompletion: Property.Checkbox({
      displayName: "Wait for completion",
      description: "Require the child workflow to succeed before continuing this workflow.",
      required: false,
      defaultValue: false,
    }),
    payload: Property.Json({
      displayName: "Payload",
      description:
        "Optional JSON object passed as the trigger payload of the called flow.",
      required: false,
    }),
  },
  async run(context) {
    const url = trimSlash(context.server.apiUrl) + "/v1/jarvis/workflows/start";
    const flowId = context.propsValue["flow"];
    const payload = context.propsValue["payload"];

    // Pre-migration shape (`settings.input.flowName` / `flowId` from
    // before the picker landed) has no `flow` key. The error below
    // surfaces in the step's failure trace; the user re-opens the
    // step in the editor and picks via the workflow picker. No silent
    // crash, no daemon-side migration needed -- the failure forces a
    // re-pick which writes the new shape.
    if (typeof flowId !== "string" || flowId.length === 0) {
      throw new Error("jarvis-trigger.run_workflow: `flow` is required");
    }
    const body: Record<string, unknown> = { flowId };
    const waitForCompletion = context.propsValue["waitForCompletion"] ?? false;
    if (typeof waitForCompletion !== 'boolean') throw new Error('waitForCompletion must be a boolean');
    // Omission retains the identity of existing fire-and-forget effects.
    if (waitForCompletion) body['waitForCompletion'] = true;
    if (payload !== undefined && payload !== null) {
      if (typeof payload !== "object" || Array.isArray(payload)) {
        throw new Error("jarvis-trigger.run_workflow: payload must be a JSON object if provided");
      }
      body["payload"] = payload;
    }

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${context.server.token}`,
        'X-Jarvis-Step-Name': context.step.name,
        'X-Jarvis-Execution-Path': JSON.stringify(context.step.executionPath ?? []),
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `jarvis-trigger.run_workflow: daemon responded ${response.status}: ${text.slice(0, 500)}`,
      );
    }
    const reply = (await response.json()) as RunWorkflowResponse;
    if (reply.approval) {
      context.run.waitForWaitpoint(reply.approval.waitpointId);
      return reply;
    }
    if (reply.waitpointId) {
      context.run.waitForWaitpoint(reply.waitpointId);
      return reply;
    }
    if (waitForCompletion) {
      if (!reply.child?.outcome) throw new Error('Child completion receipt is unavailable');
      assertActionSucceeded(reply.child.outcome);
    }
    return reply;
  },
});

function trimSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

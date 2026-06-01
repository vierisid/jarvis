/**
 * `run_workflow` action -- POST `{ flowId, payload? }` to
 * `/v1/jarvis/workflows/start`. Fire-and-forget: returns the started
 * run id.
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

interface RunWorkflowResponse {
  runId: string;
}

export const runWorkflowAction = createAction({
  name: "run_workflow",
  displayName: "Run another workflow",
  description:
    "Trigger a saved workflow by id. Returns the started run id. Fire-and-forget; the called workflow runs asynchronously.",
  // Fire-and-forget: response is just the queued run id. The called
  // flow's own outputs are NOT available here -- a downstream step
  // that needs the result must instead poll the run id, or the
  // called flow can write to a shared store / send a notification.
  outputSample: {
    runId: "run_01HX...",
  },
  props: {
    flow: Property.ShortText({
      displayName: "Flow",
      description: "Pick a workflow to run.",
      required: true,
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
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `jarvis-trigger.run_workflow: daemon responded ${response.status}: ${text.slice(0, 500)}`,
      );
    }
    return (await response.json()) as RunWorkflowResponse;
  },
});

function trimSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

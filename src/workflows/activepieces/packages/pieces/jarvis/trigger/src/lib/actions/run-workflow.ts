/**
 * `run_workflow` action -- POST `{ flowId?, flowName?, payload? }` to
 * `/v1/jarvis/workflows/start`. Either flowId or flowName is required;
 * payload is optional. Fire-and-forget: returns the started run id.
 */

import { createAction, Property } from "@activepieces/pieces-framework";

interface RunWorkflowResponse {
  runId: string;
}

export const runWorkflowAction = createAction({
  name: "run_workflow",
  displayName: "Run another workflow",
  description:
    "Trigger a saved workflow by id or name. Returns the started run id. Fire-and-forget; the called workflow runs asynchronously.",
  // Fire-and-forget: response is just the queued run id. The called
  // flow's own outputs are NOT available here -- a downstream step
  // that needs the result must instead poll the run id, or the
  // called flow can write to a shared store / send a notification.
  outputSample: {
    runId: "run_01HX...",
  },
  props: {
    flowId: Property.ShortText({
      displayName: "Flow id",
      description: "Provide either flowId or flowName.",
      required: false,
    }),
    flowName: Property.ShortText({
      displayName: "Flow name",
      required: false,
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
    const flowId = context.propsValue["flowId"];
    const flowName = context.propsValue["flowName"];
    const payload = context.propsValue["payload"];

    const body: Record<string, unknown> = {};
    if (typeof flowId === "string" && flowId.length > 0) body["flowId"] = flowId;
    if (typeof flowName === "string" && flowName.length > 0) body["flowName"] = flowName;
    if (!body["flowId"] && !body["flowName"]) {
      throw new Error("jarvis-trigger.run_workflow: requires flowId or flowName");
    }
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

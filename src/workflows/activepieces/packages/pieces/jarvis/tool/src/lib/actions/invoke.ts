/**
 * `invoke` action -- POST to `/v1/jarvis/tools/invoke` with `{ toolName, params }`
 * and return whatever the tool produced. Parameter shape is the tool's
 * concern: pieces don't duplicate its validation.
 */

import { createAction, Property } from "@activepieces/pieces-framework";

interface InvokeResponse {
  result: unknown;
  toolName: string;
  approval?: { effectId: string; approvalId: string; waitpointId: string };
}

export const invokeAction = createAction({
  name: "invoke",
  displayName: "Invoke a Jarvis tool",
  description:
    "Call a supported Jarvis tool under Authority policy. Pauses for approval when required and returns the tool's raw result.",
  // The envelope is always `{ result, toolName }`; the shape of
  // `result` is the called tool's concern. We declare a string here
  // as a representative example -- many Jarvis tools return a
  // human-readable string. For tools that return structured data, the
  // user can drill in with `{{step.result.<field>}}` after seeing it
  // captured from a successful run.
  outputSample: {
    result: "File written successfully.",
    toolName: "write_file",
  },
  props: {
    toolName: Property.ShortText({
      displayName: "Tool name",
      description:
        "Exact id of a tool with a supported Authority capability (e.g. read_file, write_file). Raw commands and ambiguous UI actions require a governed adapter.",
      required: true,
    }),
    params: Property.Json({
      displayName: "Parameters",
      description:
        "JSON arguments for the tool. Arguments and the execution target are included when approval is needed.",
      required: false,
      defaultValue: {},
    }),
  },
  async run(context) {
    const url = trimSlash(context.server.apiUrl) + "/v1/jarvis/tools/invoke";
    const toolName = context.propsValue["toolName"];
    const params = context.propsValue["params"] ?? {};
    if (typeof toolName !== "string" || toolName.length === 0) {
      throw new Error("jarvis-tool: toolName is required and must be a non-empty string");
    }
    if (typeof params !== "object" || params === null || Array.isArray(params)) {
      throw new Error("jarvis-tool: params must be a JSON object");
    }
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${context.server.token}`,
        'X-Jarvis-Step-Name': context.step.name,
        'X-Jarvis-Execution-Path': JSON.stringify(context.step.executionPath ?? []),
      },
      body: JSON.stringify({ toolName, params }),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `jarvis-tool: daemon responded ${response.status}: ${text.slice(0, 500)}`,
      );
    }
    const reply = (await response.json()) as InvokeResponse;
    if (reply.approval) context.run.waitForWaitpoint(reply.approval.waitpointId);
    return reply;
  },
});

function trimSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/**
 * `invoke` action -- POST to `/v1/jarvis/tools/invoke` with `{ toolName, params }`
 * and return whatever the tool produced. Parameter shape is the tool's
 * concern: pieces don't duplicate its validation.
 */

import { createAction, Property } from "@activepieces/pieces-framework";

interface InvokeResponse {
  result: unknown;
  toolName: string;
}

export const invokeAction = createAction({
  name: "invoke",
  displayName: "Invoke a Jarvis tool",
  description:
    "Call a registered Jarvis tool by name with the given parameters. Returns the tool's raw result.",
  // The envelope is always `{ result, toolName }`; the shape of
  // `result` is the called tool's concern. We declare a string here
  // as a representative example -- many Jarvis tools return a
  // human-readable string. For tools that return structured data, the
  // user can drill in with `{{step.result.<field>}}` after seeing it
  // captured from a successful run.
  outputSample: {
    result: "Saved 3 records to the vault.",
    toolName: "vault_search",
  },
  props: {
    toolName: Property.ShortText({
      displayName: "Tool name",
      description:
        "Exact id of the registered Jarvis tool (e.g. run_command, vault_search).",
      required: true,
    }),
    params: Property.Json({
      displayName: "Parameters",
      description:
        "JSON object passed verbatim to the tool's execute() function.",
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
      },
      body: JSON.stringify({ toolName, params }),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `jarvis-tool: daemon responded ${response.status}: ${text.slice(0, 500)}`,
      );
    }
    return (await response.json()) as InvokeResponse;
  },
});

function trimSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

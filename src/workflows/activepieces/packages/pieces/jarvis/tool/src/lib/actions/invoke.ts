/**
 * `invoke` action -- POST the tool invocation and assert its typed outcome.
 * Parameter shape remains the tool's concern. Explicit probes expose the
 * outcome to the graph instead of treating a blocked action as completion.
 */

import { createAction, Property } from "@activepieces/pieces-framework";
import { assertActionSucceeded, isActionOutcome, type ActionOutcome } from '../../../../../../../../../actions/action-outcome';

interface InvokeResponse {
  result: unknown;
  toolName: string;
  approval?: { effectId: string; approvalId: string; waitpointId: string };
  outcome?: ActionOutcome;
}

export const invokeAction = createAction({
  name: "invoke",
  displayName: "Invoke a Jarvis tool",
  description:
    "Call a supported Jarvis tool under Authority policy. Pauses for approval and requires success by default. Explicit probes return an outcome the graph can handle.",
  // Completed invocations return `{ result, toolName, outcome }`; the shape of
  // `result` is the called tool's concern. We declare a string here
  // as a representative example -- many Jarvis tools return a
  // human-readable string. For tools that return structured data, the
  // user can drill in with `{{step.result.<field>}}` after seeing it
  // captured from a successful run.
  outputSample: {
    result: "File written successfully.",
    toolName: "write_file",
    outcome: { status: 'succeeded' },
  },
  props: {
    requireSuccess: Property.Checkbox({
      displayName: 'Require successful action',
      description: 'Stop on blocked, error or unknown outcomes. Disable only when the graph explicitly handles the outcome, for example an availability probe. This never bypasses Authority or permits automatic retry.',
      required: false,
      defaultValue: true,
    }),
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
    const requireSuccess = context.propsValue['requireSuccess'] ?? true;
    if (typeof requireSuccess !== 'boolean') throw new Error('jarvis-tool: requireSuccess must be a boolean');
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
      body: JSON.stringify({ toolName, params, requireSuccess }),
    });
    const text = await response.text();
    let reply: InvokeResponse;
    try { reply = JSON.parse(text); } catch {
      throw new Error(`jarvis-tool: invalid daemon response (${response.status})`);
    }
    if (response.ok && reply?.approval) {
      context.run.waitForWaitpoint(reply.approval.waitpointId);
      return reply;
    }
    if (!isActionOutcome(reply?.outcome)) {
      throw new Error(`jarvis-tool: daemon response lacks an action outcome (${response.status}): ${text.slice(0, 500)}`);
    }
    if (requireSuccess) assertActionSucceeded(reply.outcome);
    if (!response.ok) throw new Error(`jarvis-tool: daemon responded ${response.status}: ${text.slice(0, 500)}`);
    return reply;
  },
});

function trimSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/**
 * `ask` action -- POST to the daemon's `/v1/jarvis/llm/chat` endpoint with
 * the resolved prompt and return the LLM's reply as the step output, with
 * its typed outcome asserted.
 *
 * The endpoint URL is derived from `context.server.apiUrl` (which the engine
 * sets to the daemon's `internalApiUrl`). Auth uses `context.server.token`
 * (the per-run engineToken). All actual LLM provider state lives in the
 * daemon, never in the engine subprocess.
 */

import { createAction, Property } from "@activepieces/pieces-framework";
import { assertActionSucceeded, isActionOutcome, type ActionOutcome } from '../../../../../../../../../actions/action-outcome';

interface AskResponse {
  text: string;
  parsed?: unknown;
  approval?: { effectId: string; approvalId: string; waitpointId: string };
  outcome?: ActionOutcome;
}

export const askAction = createAction({
  name: "ask",
  displayName: "Ask",
  description: "Send a prompt to Jarvis's LLM and receive the reply. A step that asks for JSON fails when the reply misses that contract, unless the graph explicitly handles the outcome.",
  // Variable-picker hint: a completed call always returns `text` and
  // `outcome`; `parsed` carries the JSON.parse'd reply only when JSON was
  // requested and the outcome succeeded. We surface all three so a flow that
  // wires `{{step.parsed}}` or `{{step.outcome.status}}` shows up as a row
  // before the action has run.
  outputSample: {
    text: "Here's a one-line summary of your inbox: ...",
    parsed: null,
    outcome: { status: 'succeeded' },
  },
  props: {
    prompt: Property.LongText({
      displayName: "Prompt",
      description: "The user prompt to send to the LLM.",
      required: true,
    }),
    system: Property.LongText({
      displayName: "System",
      description:
        "Extra system instructions APPENDED to the standard Jarvis system prompt. Use this to bias the reply (e.g. \"answer in JSON\"). Turn on Override to replace the Jarvis prompt entirely instead.",
      required: false,
    }),
    overrideSystem: Property.Checkbox({
      displayName: "Override Jarvis system prompt",
      description:
        "When ON, the System field above becomes the ONLY system prompt -- Jarvis's identity, role, personality, and vault context are not sent. Use for generic LLM tasks (text transforms, summarisation of plain inputs) where Jarvis context would bias the reply. Leave OFF (default) when you want the model to answer as Jarvis.",
      required: false,
      defaultValue: false,
    }),
    parseJson: Property.Checkbox({
      displayName: "Parse JSON",
      description:
        "Require the reply to be JSON. `parsed` carries the parsed value and the step fails on a reply that is not JSON, unless Require valid output is off. The reply must be bare JSON: no code fences, no commentary.",
      required: false,
      defaultValue: false,
    }),
    outputSchema: Property.LongText({
      displayName: "Output schema (JSON)",
      description:
        "Optional JSON Schema the parsed reply must match. Supported keywords: type, properties, required, additionalProperties, items, enum, minItems, maxItems, minLength, maxLength, minimum, maximum. Any other keyword is refused before the prompt is sent. Implies Parse JSON. Describe the shape in the prompt as well: the schema checks the reply, it does not steer the model.",
      required: false,
    }),
    requireSuccess: Property.Checkbox({
      displayName: "Require valid output",
      description:
        "Stop the step when the reply misses the JSON or schema contract. Turn off only when a later step routes on {{step.outcome.status}} and handles the failure itself; `text` is still returned, `parsed` is not.",
      required: false,
      defaultValue: true,
    }),
  },
  async run(context) {
    const url = trimSlash(context.server.apiUrl) + "/v1/jarvis/llm/chat";
    const body: Record<string, unknown> = {
      prompt: context.propsValue["prompt"],
    };
    if (context.propsValue["system"]) body["system"] = context.propsValue["system"];
    if (context.propsValue["overrideSystem"]) body["overrideSystem"] = true;
    if (context.propsValue["parseJson"]) body["parseJson"] = true;
    const requireSuccess = context.propsValue["requireSuccess"] ?? true;
    if (typeof requireSuccess !== "boolean") throw new Error("jarvis-ask: requireSuccess must be a boolean");
    body["requireSuccess"] = requireSuccess;
    const outputSchema = outputSchemaFrom(context.propsValue["outputSchema"]);
    if (outputSchema !== undefined) body["outputSchema"] = outputSchema;

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
    const text = await response.text();
    let reply: AskResponse;
    try { reply = JSON.parse(text); } catch {
      throw new Error(`jarvis-ask: invalid daemon response (${response.status})`);
    }
    if (response.ok && reply?.approval) {
      context.run.waitForWaitpoint(reply.approval.waitpointId);
      return reply;
    }
    if (!isActionOutcome(reply?.outcome)) {
      if (!response.ok) throw new Error(`jarvis-ask: daemon responded ${response.status}: ${text.slice(0, 500)}`);
      throw new Error(`jarvis-ask: daemon response lacks an action outcome (${response.status}): ${text.slice(0, 500)}`);
    }
    if (requireSuccess) assertActionSucceeded(reply.outcome);
    if (!response.ok) throw new Error(`jarvis-ask: daemon responded ${response.status}: ${text.slice(0, 500)}`);
    return reply;
  },
});

/**
 * The schema is taken as text and parsed here on purpose. The engine's JSON
 * property processor drops a value it cannot parse, which would run the
 * prompt with no contract at all; a schema that cannot be read has to fail
 * the step before anything is sent.
 */
function outputSchemaFrom(value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") {
    if (value.trim() === "") return undefined;
    try { return JSON.parse(value); } catch {
      throw new Error("jarvis-ask: outputSchema is not valid JSON");
    }
  }
  return value;
}

function trimSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

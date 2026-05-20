/**
 * `ask` action -- POST to the daemon's `/v1/jarvis/llm/chat` endpoint with
 * the resolved prompt and return the LLM's reply as the step output.
 *
 * The endpoint URL is derived from `context.server.apiUrl` (which the engine
 * sets to the daemon's `internalApiUrl`). Auth uses `context.server.token`
 * (the per-run engineToken). All actual LLM provider state lives in the
 * daemon, never in the engine subprocess.
 */

import { createAction, Property } from "@activepieces/pieces-framework";

interface AskResponse {
  text: string;
  parsed?: unknown;
}

export const askAction = createAction({
  name: "ask",
  displayName: "Ask",
  description: "Send a prompt to Jarvis's LLM and receive the reply.",
  // Variable-picker hint: a successful call always returns `text`; when
  // `Parse JSON` is on, `parsed` carries the JSON.parse'd reply (else
  // absent). We surface both so a flow that wires `{{step.parsed}}`
  // shows up as a row before the action has run.
  outputSample: {
    text: "Here's a one-line summary of your inbox: ...",
    parsed: null,
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
      description: "Attempt to parse the reply as JSON before returning it.",
      required: false,
      defaultValue: false,
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
        `jarvis-ask: daemon responded ${response.status}: ${text.slice(0, 500)}`,
      );
    }
    const data = (await response.json()) as AskResponse;
    return data;
  },
});

function trimSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

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
  props: {
    prompt: Property.LongText({
      displayName: "Prompt",
      description: "The user prompt to send to the LLM.",
      required: true,
    }),
    system: Property.LongText({
      displayName: "System",
      description: "Optional system message prefacing the conversation.",
      required: false,
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

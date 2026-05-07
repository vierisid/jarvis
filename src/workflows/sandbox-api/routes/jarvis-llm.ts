/**
 * `/v1/jarvis/llm/chat` -- backs the `jarvis-ask` piece's `ask` action.
 *
 * The piece-side action posts `{ prompt, system?, parseJson? }` and expects
 * back `{ text, parsed? }`. Implementation here is a thin wrapper around a
 * `LlmChatFn` injected via `SandboxApiServices.llmChat`; the real LLM client
 * is provided by the daemon. Keeping the function pluggable lets tests
 * substitute a deterministic fake.
 *
 * The endpoint is auth-gated like the rest of `/v1/*` (Bearer engineToken).
 * It is not exposed externally -- only the engine subprocess hits it.
 */

import { json, err, type RouteContext, type RouteHandler } from "./shared";

export interface LlmChatRequest {
  prompt: string;
  system?: string;
  parseJson?: boolean;
}

export interface LlmChatResponse {
  text: string;
  parsed?: unknown;
}

export type LlmChatFn = (
  req: LlmChatRequest,
  ctx: { runId: string; projectId: string },
) => Promise<LlmChatResponse>;

export interface JarvisLlmRouteDeps {
  /**
   * If unset, the route returns 503 -- handy default for tests/setup that
   * don't care about LLM until they explicitly wire it.
   */
  llmChat?: LlmChatFn;
}

export function createJarvisLlmChatRoute(deps: JarvisLlmRouteDeps): RouteHandler {
  return async (req: RouteContext) => {
    if (!deps.llmChat) {
      return err("jarvis llm chat not configured", 503);
    }
    let body: LlmChatRequest;
    try {
      body = (await req.json()) as LlmChatRequest;
    } catch {
      return err("invalid JSON body", 400);
    }
    if (typeof body.prompt !== "string" || body.prompt.length === 0) {
      return err("prompt must be a non-empty string", 400);
    }
    const reply = await deps.llmChat(body, {
      runId: req.claims.runId,
      projectId: req.claims.projectId,
    });
    return json(reply);
  };
}

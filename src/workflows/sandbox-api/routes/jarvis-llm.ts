/**
 * `/v1/jarvis/llm/chat` -- backs the `jarvis-ask` piece's `ask` action.
 *
 * The piece-side action posts `{ prompt, system?, overrideSystem?,
 * parseJson? }` and expects back `{ text, parsed? }`. Implementation
 * here is a thin wrapper around a `LlmChatFn` injected via
 * `SandboxApiServices.llmChat`; the real LLM client is provided by the
 * daemon. Keeping the function pluggable lets tests substitute a
 * deterministic fake.
 *
 * System-prompt semantics (decided in the daemon backend, not here):
 *   - default                   : Jarvis identity + role + personality
 *   - `system` set              : Jarvis prompt + "\n\n" + `system`
 *   - `system` + overrideSystem : `system` only (Jarvis context dropped)
 *
 * The endpoint is auth-gated like the rest of `/v1/*` (Bearer engineToken).
 * It is not exposed externally -- only the engine subprocess hits it. The call
 * itself passes the daemon's Authority boundary: a prompt is the workflow's
 * cheapest route off-device, so the text sent is recorded on a durable effect
 * and can be denied, paused or held for approval like any other effect.
 */

import { json, err, parseJsonObject, type RouteContext, type RouteHandler } from "./shared";
import { cancellableWorkflowService } from "../../runtime/cancellation";
import { workflowEffectContext } from './effect-context';
import type { WorkflowEffectContext, WorkflowApprovalPending } from '../../runtime/effect-context';

export interface LlmChatRequest {
  prompt: string;
  system?: string;
  /**
   * When true, the `system` field replaces the Jarvis system prompt
   * entirely. When false / unset, `system` is appended to the Jarvis
   * prompt. Default off so the common case ("ask Jarvis to do X") still
   * carries the Jarvis identity.
   */
  overrideSystem?: boolean;
  parseJson?: boolean;
}

export interface LlmChatResponse {
  text: string;
  parsed?: unknown;
  /** Present when Authority requires approval; the piece parks on the waitpoint. */
  approval?: WorkflowApprovalPending;
}

export type LlmChatFn = (
  req: LlmChatRequest,
  ctx: WorkflowEffectContext,
) => Promise<LlmChatResponse>;

export interface JarvisLlmRouteDeps {
  /**
   * If unset, the route returns 503 -- handy default for tests/setup that
   * don't care about LLM until they explicitly wire it.
   */
  llmChat?: LlmChatFn;
}

export function createJarvisLlmChatRoute(deps: JarvisLlmRouteDeps): RouteHandler {
  return async (ctx: RouteContext) => {
    if (!deps.llmChat) {
      return err("jarvis llm chat not configured", 503);
    }
    const raw = await parseJsonObject(ctx);
    if (raw instanceof Response) return raw;
    if (typeof raw.prompt !== "string" || raw.prompt.length === 0) {
      return err("prompt must be a non-empty string", 400);
    }
    const body: LlmChatRequest = { prompt: raw.prompt };
    if (typeof raw.system === "string") body.system = raw.system;
    if (raw.overrideSystem === true) body.overrideSystem = true;
    if (raw.parseJson === true) body.parseJson = true;
    const reply = await cancellableWorkflowService(deps.llmChat)(body, workflowEffectContext(ctx));
    return json(reply);
  };
}

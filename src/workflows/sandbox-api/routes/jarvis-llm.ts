/**
 * `/v1/jarvis/llm/chat` -- backs the `jarvis-ask` piece's `ask` action.
 *
 * The piece posts `{ prompt, system?, overrideSystem?, parseJson?,
 * outputSchema?, requireSuccess? }` and receives `{ text, parsed?, outcome }`
 * or a pending approval. Implementation here is a thin wrapper around an
 * `LlmChatFn` injected via `SandboxApiServices.llmChat`; the real LLM client
 * is provided by the daemon. Keeping the function pluggable lets tests
 * substitute a deterministic fake.
 *
 * System-prompt semantics (decided in the daemon backend, not here):
 *   - default                   : Jarvis identity + role + personality
 *   - `system` set              : Jarvis prompt + "\n\n" + `system`
 *   - `system` + overrideSystem : `system` only (Jarvis context dropped)
 *
 * Output contract: a step that asked for JSON (`parseJson` or `outputSchema`)
 * gets a typed `outcome`, and `parsed` exists only when that outcome is
 * `succeeded`. A failed contract answers 422 and the piece stops the step;
 * `requireSuccess: false` answers 200 with the same outcome so the graph can
 * route on it. A schema declaration the validator cannot honor is refused
 * with 400 before any prompt leaves the device.
 *
 * The endpoint is auth-gated like the rest of `/v1/*` (Bearer engineToken).
 * It is not exposed externally -- only the engine subprocess hits it. The call
 * itself passes the daemon's Authority boundary: a prompt is the workflow's
 * cheapest route off-device, so the text sent is recorded on a durable effect
 * and can be denied, paused or held for approval like any other effect.
 */

import { json, err, parseJsonObject, type RouteContext, type RouteHandler } from "./shared";
import { cancellableWorkflowService } from "../../runtime/cancellation";
import { OutputSchemaError, evaluateLlmOutput, parseOutputSchema, type OutputSchema } from '../../runtime/llm-output-contract';
import type { ActionOutcome } from '../../../actions/action-outcome';
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
  /** Require the reply to be JSON. */
  parseJson?: boolean;
  /**
   * Closed JSON Schema subset the parsed reply must match (see
   * `runtime/llm-output-contract.ts`). Implies `parseJson`.
   */
  outputSchema?: OutputSchema;
  /** Defaults to true. False returns a handled outcome instead of failing the step. */
  requireSuccess?: boolean;
}

export interface LlmChatResponse {
  text: string;
  /** Present only when JSON was requested and `outcome.status` is `succeeded`. */
  parsed?: unknown;
  /** Present when Authority requires approval; the piece parks on the waitpoint. */
  approval?: WorkflowApprovalPending;
  /** Present on every completed call. */
  outcome?: ActionOutcome;
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
    if (raw.requireSuccess !== undefined) {
      if (typeof raw.requireSuccess !== 'boolean') return err('requireSuccess must be a boolean', 400);
      body.requireSuccess = raw.requireSuccess;
    }
    if (raw.outputSchema !== undefined) {
      try {
        body.outputSchema = parseOutputSchema(raw.outputSchema);
      } catch (error) {
        if (error instanceof OutputSchemaError) return err(`outputSchema: ${error.message}`, 400);
        throw error;
      }
    }
    const reply = await cancellableWorkflowService(deps.llmChat)(body, workflowEffectContext(ctx));
    if (reply.approval) return json(reply, 202);
    // A backend, or a receipt written before this contract existed, can answer
    // with the text alone. The route owns the contract, so it evaluates that
    // text itself instead of stamping success on it.
    const completed = reply.outcome ? reply : evaluatedReply(reply, body);
    const outcome = completed.outcome!;
    // HTTP success for a handled outcome acknowledges that the outcome was
    // returned; it does not claim the reply met the contract. 409 and 502
    // mirror the tool route; today's evaluation only yields succeeded or error.
    const status = outcome.status === 'succeeded' || raw.requireSuccess === false ? 200
      : outcome.status === 'blocked' ? 409 : outcome.status === 'error' ? 422 : 502;
    return json(completed, status);
  };
}

function evaluatedReply(reply: LlmChatResponse, request: LlmChatRequest): LlmChatResponse {
  const { parsed: _unqualified, outcome: _absent, ...rest } = reply;
  const evaluated = evaluateLlmOutput({ text: reply.text, ...(request.parseJson ? { parseJson: true } : {}),
    ...(request.outputSchema ? { outputSchema: request.outputSchema } : {}) });
  return 'parsed' in evaluated ? { ...rest, parsed: evaluated.parsed, outcome: evaluated.outcome } : { ...rest, outcome: evaluated.outcome };
}

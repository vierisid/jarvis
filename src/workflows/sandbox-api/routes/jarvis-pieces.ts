/**
 * `/v1/jarvis/pieces/authorize` -- the admission point for a verified piece's
 * action, called by the engine's `piece-executor` before the piece runs.
 *
 * Unlike the other `/v1/jarvis/*` routes this one does not perform the effect:
 * the piece's own outbound call happens in the engine subprocess a moment
 * later. What it does perform is the governance -- Authority decision,
 * emergency and cancellation checks, durable effect record, audit row and
 * approval waitpoint -- through the same `WorkflowEffectBoundary` as every
 * other workflow effect. The recorded outcome is therefore a DISPATCH
 * AUTHORIZATION, not a completion receipt.
 *
 * A piece with no adapter replies `{ governed: false }` and runs untouched.
 * The route never refuses a piece for being unknown; that is the whole point.
 */

import { json, err, parseJsonObject, type RouteContext, type RouteHandler } from "./shared";
import { cancellableWorkflowService } from "../../runtime/cancellation";
import { workflowEffectContext } from './effect-context';
import type { WorkflowEffectContext } from '../../runtime/effect-context';
import type { PieceAuthorizeRequest, PieceAuthorizeResponse } from '../../runtime/piece-effect-guard';

export type PieceAuthorizeFn = (
  req: PieceAuthorizeRequest,
  ctx: WorkflowEffectContext,
) => Promise<PieceAuthorizeResponse>;

export interface JarvisPiecesRouteDeps {
  pieceAuthorize?: PieceAuthorizeFn;
}

export function createJarvisPieceAuthorizeRoute(
  deps: JarvisPiecesRouteDeps,
): RouteHandler {
  return async (ctx: RouteContext) => {
    // 503 here fails the step closed: the engine only calls this route for a
    // piece it knows is governed.
    if (!deps.pieceAuthorize) {
      return err("jarvis pieces.authorize not configured", 503);
    }
    const raw = await parseJsonObject(ctx);
    if (raw instanceof Response) return raw;
    if (typeof raw.piece !== "string" || raw.piece.length === 0) {
      return err("piece must be a non-empty string", 400);
    }
    if (typeof raw.action !== "string" || raw.action.length === 0) {
      return err("action must be a non-empty string", 400);
    }
    if (raw.input !== undefined && (typeof raw.input !== "object" || raw.input === null || Array.isArray(raw.input))) {
      return err("input must be an object", 400);
    }
    const reply = await cancellableWorkflowService(deps.pieceAuthorize)(
      { piece: raw.piece, action: raw.action, input: (raw.input as Record<string, unknown>) ?? {} },
      workflowEffectContext(ctx),
    );
    return json(reply);
  };
}

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
 * A piece with no adapter, and a CODE step, reply `{ governed: false }` and
 * run untouched, unless Jarvis is paused (they park until Resume) or stopped
 * (they do not run) (Q-08). The route never refuses a piece for being
 * unknown; that is the whole point.
 */

import { json, err, parseJsonObject, type RouteContext, type RouteHandler } from "./shared";
import { cancellableWorkflowService } from "../../runtime/cancellation";
import { workflowEffectContext } from './effect-context';
import type { WorkflowEffectContext } from '../../runtime/effect-context';
import { PIECE_RECEIPT_MAX_BYTES, type PieceAuthorizeRequest, type PieceAuthorizeResponse } from '../../runtime/piece-effect-guard';
import { resolveGovernedPieceAction } from '../../runtime/piece-effects';

export type PieceAuthorizeFn = (
  req: PieceAuthorizeRequest,
  ctx: WorkflowEffectContext,
) => Promise<PieceAuthorizeResponse>;

export interface JarvisPiecesRouteDeps {
  pieceAuthorize?: PieceAuthorizeFn;
  pieceReceipt?: (ctx: WorkflowEffectContext, id: string, result: unknown) => void;
}

export function createJarvisPieceAuthorizeRoute(
  deps: JarvisPiecesRouteDeps,
): RouteHandler {
  return async (ctx: RouteContext) => {
    const raw = await parseJsonObject(ctx);
    if (raw instanceof Response) return raw;
    if (typeof raw.piece !== "string" || raw.piece.length === 0) {
      return err("piece must be a non-empty string", 400);
    }
    if (typeof raw.action !== "string" || raw.action.length === 0) {
      return err("action must be a non-empty string", 400);
    }
    if (!deps.pieceAuthorize) {
      // Unwired (an engine-only harness). A governed piece fails closed with
      // a 503; a step with no adapter runs as it did before Q-08.
      return resolveGovernedPieceAction(raw.piece, raw.action)
        ? err("jarvis pieces.authorize not configured", 503)
        : json({ governed: false });
    }
    if (raw.input !== undefined && (typeof raw.input !== "object" || raw.input === null || Array.isArray(raw.input))) {
      return err("input must be an object", 400);
    }
    if (raw.inputDigest !== undefined && (typeof raw.inputDigest !== "string" || !/^[0-9a-f]{64}$/.test(raw.inputDigest))) {
      return err("inputDigest must be a SHA-256 hex digest", 400);
    }
    if (raw.credentialDigest !== undefined && (typeof raw.credentialDigest !== 'string' || !/^[0-9a-f]{64}$/.test(raw.credentialDigest))) return err('Invalid credential digest', 400);
    if (raw.documentProtocol !== undefined && raw.documentProtocol !== 1) return err('Unsupported document protocol', 400);
    const reply = await cancellableWorkflowService(deps.pieceAuthorize)(
      { piece: raw.piece, action: raw.action, input: (raw.input as Record<string, unknown>) ?? {},
        ...(typeof raw.inputDigest === "string" ? { inputDigest: raw.inputDigest } : {}),
        ...(typeof raw.credentialDigest === 'string' ? { credentialDigest: raw.credentialDigest } : {}),
        ...(raw.documentProtocol === 1 ? { documentProtocol: 1 as const } : {}) },
      workflowEffectContext(ctx),
    );
    return json(reply);
  };
}

export function createJarvisPieceReceiptRoute(deps: JarvisPiecesRouteDeps): RouteHandler {
  return async ctx => {
    if (!deps.pieceReceipt) return err('Completion receipts unavailable', 503);
    const reader = ctx.req.body?.getReader();
    if (!reader) return err('Missing completion receipt', 400);
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > PIECE_RECEIPT_MAX_BYTES) { await reader.cancel(); return err(`Completion receipt exceeds ${PIECE_RECEIPT_MAX_BYTES} bytes; dispatch remains uncertain`, 413); }
      chunks.push(part.value);
    }
    let raw: Record<string, unknown>;
    try { raw = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { return err('Invalid completion receipt JSON', 400); }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return err('Invalid completion receipt', 400);
    if (typeof raw.effectId !== 'string' || !/^wfe_[a-f0-9]{64}$/.test(raw.effectId) || !Object.hasOwn(raw, 'result')) return err('Invalid completion receipt', 400);
    deps.pieceReceipt(workflowEffectContext(ctx), raw.effectId, raw.result);
    return json({ recorded: true });
  };
}

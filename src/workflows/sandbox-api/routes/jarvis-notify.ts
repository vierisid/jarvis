/**
 * `/v1/jarvis/notify` -- backs the `jarvis-notify` piece's `notify` action.
 *
 * The piece posts `{ message, channels, priority }`; the route returns
 * `{ delivered, failed, unknown }`. Channel routing / fan-out lives in the
 * daemon's notifier; this layer only validates the envelope and dispatches to
 * an injected `NotifyFn`. If no fn is configured the route returns 503. A
 * typed outcome (Q-19: nothing was sent anywhere, or the effect was refused)
 * comes back as `outcome` with a non-2xx status, as on the tools route.
 */

import { json, err, parseJsonObject, type RouteContext, type RouteHandler } from "./shared";
import { cancellableWorkflowService } from "../../runtime/cancellation";
import { workflowEffectContext } from './effect-context';
import { ActionOutcomeError, type ActionFailure } from '../../../actions/action-outcome';
import type { WorkflowEffectContext, WorkflowApprovalPending } from '../../runtime/effect-context';
import { PIECE_NOTIFY_CHANNELS } from '../../jarvis-pieces/types';

const VALID_CHANNELS: ReadonlySet<string> = new Set(PIECE_NOTIFY_CHANNELS);

const VALID_PRIORITIES = new Set(["low", "normal", "high"]);

export interface NotifyRequest {
  meetingGuard?: unknown;
  message: string;
  idempotencyKey?: string;
  channels: string[];
  priority: "low" | "normal" | "high";
}

export interface NotifyResponse {
  deduplicated?: boolean;
  delivered: string[];
  failed: { channel: string; error: string }[];
  /** Channels that may have taken it without confirming. Never reported as not sent. */
  unknown: { channel: string; error: string }[];
  approval?: WorkflowApprovalPending;
}

/**
 * The notify step's outcome when nothing was sent anywhere, with the report
 * of each channel, so the step's reply still says what happened to each.
 */
export class DeliveryFailedError extends ActionOutcomeError {
  constructor(outcome: ActionFailure, public readonly report: Omit<NotifyResponse, 'approval'>) {
    super(outcome);
    this.name = 'DeliveryFailedError';
  }
}

export type NotifyFn = (
  req: NotifyRequest,
  ctx: WorkflowEffectContext,
) => Promise<NotifyResponse>;

export interface JarvisNotifyRouteDeps {
  notify?: NotifyFn;
}

export function createJarvisNotifyRoute(
  deps: JarvisNotifyRouteDeps,
): RouteHandler {
  return async (ctx: RouteContext) => {
    if (!deps.notify) {
      return err("jarvis notify not configured", 503);
    }
    const raw = await parseJsonObject(ctx);
    if (raw instanceof Response) return raw;
    if (typeof raw.message !== "string" || raw.message.length === 0) {
      return err("message must be a non-empty string", 400);
    }
    let channels: string[] = ["auto"];
    if (raw.channels !== undefined) {
      if (!Array.isArray(raw.channels)) {
        return err("channels must be an array", 400);
      }
      const out: string[] = [];
      for (const c of raw.channels) {
        if (typeof c !== "string" || !VALID_CHANNELS.has(c)) {
          return err(
            `channels[] must contain only: ${Array.from(VALID_CHANNELS).join(", ")}`,
            400,
          );
        }
        out.push(c);
      }
      channels = out.length > 0 ? out : ["auto"];
    }
    let priority: "low" | "normal" | "high" = "normal";
    if (raw.priority !== undefined) {
      if (typeof raw.priority !== "string" || !VALID_PRIORITIES.has(raw.priority)) {
        return err("priority must be 'low', 'normal', or 'high'", 400);
      }
      priority = raw.priority as "low" | "normal" | "high";
    }
    if (raw.idempotencyKey !== undefined && (typeof raw.idempotencyKey !== 'string' || !raw.idempotencyKey.trim() || raw.idempotencyKey.length > 256))
      return err('idempotencyKey must be a non-empty string of at most 256 characters',400);
    let reply: NotifyResponse;
    try {
      reply = await cancellableWorkflowService(deps.notify)(
        { message: raw.message, channels, priority, ...(raw.meetingGuard == null ? {} : { meetingGuard: raw.meetingGuard }), ...(typeof raw.idempotencyKey === 'string' ? {idempotencyKey:raw.idempotencyKey} : {}) },
        workflowEffectContext(ctx),
      );
    } catch (error) {
      if (!(error instanceof ActionOutcomeError)) throw error;
      const outcome: ActionFailure = error.outcome;
      // A replayed refusal has no report; a fresh one keeps each channel's.
      const report = error instanceof DeliveryFailedError ? error.report : { delivered: [], failed: [], unknown: [] };
      return json({ ...report, outcome },
        outcome.status === 'blocked' ? 409 : outcome.status === 'error' ? 422 : 502);
    }
    return json(reply);
  };
}

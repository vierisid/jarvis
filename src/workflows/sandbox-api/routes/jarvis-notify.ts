/**
 * `/v1/jarvis/notify` -- backs the `jarvis-notify` piece's `notify` action.
 *
 * The piece posts `{ message, channels, priority }`; the route returns
 * `{ delivered, failed }`. Channel routing / fan-out lives in the daemon's
 * notifier; this layer only validates the envelope and dispatches to an
 * injected `NotifyFn`. If no fn is configured the route returns 503.
 */

import { json, err, parseJsonObject, type RouteContext, type RouteHandler } from "./shared";

const VALID_CHANNELS = new Set([
  "auto",
  "telegram",
  "discord",
  "voice",
  "dashboard",
  "desktop",
]);

const VALID_PRIORITIES = new Set(["low", "normal", "high"]);

export interface NotifyRequest {
  message: string;
  channels: string[];
  priority: "low" | "normal" | "high";
}

export interface NotifyResponse {
  delivered: string[];
  failed: { channel: string; error: string }[];
}

export type NotifyFn = (
  req: NotifyRequest,
  ctx: { runId: string; projectId: string },
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
    const reply = await deps.notify(
      { message: raw.message, channels, priority },
      { runId: ctx.claims.runId, projectId: ctx.claims.projectId },
    );
    return json(reply);
  };
}

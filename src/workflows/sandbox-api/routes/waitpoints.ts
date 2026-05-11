/**
 * `POST /v1/waitpoints` -- backs `context.run.createWaitpoint()`.
 *
 * The engine sends `{ flowRunId, projectId, stepName, type, version,
 * resumeDateTime?, responseToSend?, workerHandlerId?, httpRequestId? }`. We
 * persist the row and return `{ resumeUrl, waitpointId }` -- the engine puts
 * `resumeUrl` in step output so external callers can hit it later to wake the
 * flow.
 *
 * The actual resume scheduling (TIMER tick, WEBHOOK route, etc.) is layered on
 * after this commit; today the row is just persisted.
 */

import { createWaitpoint } from "../../db/repos/waitpoint";
import type { WaitpointType } from "../../db/repos/waitpoint";
import { json, err, type RouteContext, type RouteHandler } from "./shared";

interface CreateWaitpointBody {
  flowRunId?: string;
  projectId?: string;
  stepName?: string;
  type?: string;
  version?: string;
  resumeDateTime?: string;
  responseToSend?: Record<string, unknown>;
  workerHandlerId?: string;
  httpRequestId?: string;
}

const ALLOWED_TYPES: ReadonlySet<WaitpointType> = new Set<WaitpointType>([
  "WEBHOOK",
  "TIMER",
  "MANUAL",
]);

export interface WaitpointRouteDeps {
  /** Public URL prefix used to construct the resumeUrl returned to the engine. */
  resumeUrlPrefix: string;
}

export function createWaitpointsRoute(deps: WaitpointRouteDeps): RouteHandler {
  return async (ctx: RouteContext) => {
    let body: CreateWaitpointBody;
    try {
      body = (await ctx.req.json()) as CreateWaitpointBody;
    } catch {
      return err("invalid JSON body", 400);
    }
    if (!body.flowRunId) return err("missing flowRunId", 400);
    if (!body.stepName) return err("missing stepName", 400);
    if (!body.type || !ALLOWED_TYPES.has(body.type as WaitpointType)) {
      return err(`unsupported waitpoint type ${body.type}`, 400);
    }
    if (body.flowRunId !== ctx.claims.runId) {
      return err("flowRunId does not match this sandbox", 403);
    }
    const wp = createWaitpoint({
      flowRunId: body.flowRunId,
      projectId: body.projectId ?? ctx.claims.projectId,
      stepName: body.stepName,
      type: body.type as WaitpointType,
      version: body.version,
      resumeDateTime: body.resumeDateTime,
      responseToSend: body.responseToSend,
      workerHandlerId: body.workerHandlerId,
      httpRequestId: body.httpRequestId,
    });

    return json({
      waitpointId: wp.id,
      resumeUrl: `${deps.resumeUrlPrefix}/${wp.id}`,
    });
  };
}

/**
 * `POST /v1/waitpoints` -- backs `context.run.createWaitpoint()`.
 *
 * The engine sends `{ flowRunId, projectId, stepName, type, version,
 * resumeDateTime?, responseToSend?, workerHandlerId?, httpRequestId? }`. We
 * persist the row and return `{ resumeUrl, waitpointId }` -- the engine puts
 * `resumeUrl` in step output so external callers can hit it later to wake the
 * flow.
 *
 * TIMER/DELAY waitpoints are resumed by the TimerWaitpointScheduler; WEBHOOK by
 * the resume route.
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

// Accepted engine-side waitpoint types. The pieces framework emits `DELAY`
// (timer-based) + `WEBHOOK`; we also accept `TIMER`/`MANUAL`. `DELAY` is a
// timer, so it's STORED as `TIMER` — both mean "resume at resume_date_time" and
// the TIMER scheduler keys off that single type.
const ACCEPTED_TYPES: ReadonlySet<string> = new Set(["WEBHOOK", "TIMER", "MANUAL", "DELAY"]);

function normalizeType(t: string): WaitpointType {
  return t === "DELAY" ? "TIMER" : (t as WaitpointType);
}

// `resume_date_time` is compared LEXICALLY by the scheduler, so it must be
// canonical ISO-8601 UTC. Delay pieces send either `toISOString()` (delay-until)
// or `toUTCString()` (delay-for, RFC-1123) — normalize both. An unparseable
// value drops to undefined rather than persisting a never-due timer.
function normalizeResumeDateTime(raw?: string): string | undefined {
  if (!raw) return undefined;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

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
    if (!body.type || !ACCEPTED_TYPES.has(body.type)) {
      return err(`unsupported waitpoint type ${body.type}`, 400);
    }
    if (body.flowRunId !== ctx.claims.runId) {
      return err("flowRunId does not match this sandbox", 403);
    }
    const wp = createWaitpoint({
      flowRunId: body.flowRunId,
      projectId: body.projectId ?? ctx.claims.projectId,
      stepName: body.stepName,
      type: normalizeType(body.type),
      version: body.version,
      resumeDateTime: normalizeResumeDateTime(body.resumeDateTime),
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

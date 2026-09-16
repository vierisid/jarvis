/**
 * `/v1/jarvis/context/*` -- backs the `jarvis-context` piece's four read-only
 * actions. One route per action so each can validate its own envelope; all
 * four delegate to a single injected `JarvisContextProvider` shaped exactly
 * like the legacy adapter, so the daemon can supply a `JarvisContextProviderAdapter`
 * verbatim.
 *
 * Routes:
 *   POST /v1/jarvis/context/vault-search
 *   POST /v1/jarvis/context/vault-get-entity
 *   POST /v1/jarvis/context/awareness-recent
 *   POST /v1/jarvis/context/commitments-list
 *
 * These are reads, but they read the most sensitive stores Jarvis has (vault
 * entities, commitments and screen-capture history), so they pass the same
 * daemon-owned Authority boundary as every other workflow effect.
 *
 * A successful reply keeps its original bare shape -- the actions declare it in
 * `outputSample` and downstream LOOP steps bind to it. An approval-pending
 * reply cannot be squeezed into a bare array, so it is a `202` carrying
 * `{ approval }`; the piece parks on the waitpoint and returns a placeholder.
 */

import { json, err, parseJsonObject, type RouteContext, type RouteHandler } from "./shared";
import { workflowEffectContext } from './effect-context';
import type { WorkflowEffectContext, WorkflowApprovalPending } from '../../runtime/effect-context';

const VAULT_TYPES = new Set([
  "person",
  "project",
  "tool",
  "place",
  "concept",
  "event",
]);

const COMMITMENT_STATUSES = new Set([
  "pending",
  "in_progress",
  "completed",
  "failed",
]);

export interface VaultSearchRequest {
  query?: string;
  type?: string;
  limit?: number;
}

export interface VaultEntitySnapshot {
  id: string;
  type: string;
  name: string;
  properties: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
}

export interface AwarenessRecentRequest {
  limit?: number;
  since?: number;
}

export interface AwarenessActivitySnapshot {
  id: string;
  appName: string | null;
  windowTitle: string | null;
  url: string | null;
  startTime: number;
  endTime: number | null;
  summary: string | null;
}

export interface CommitmentsListRequest {
  status?: string;
  limit?: number;
}

export interface CommitmentSnapshot {
  id: string;
  description: string;
  status: string;
  dueAt: number | null;
  priority: string;
  createdAt: number;
}

/** Either the read's result or the approval the caller must wait on. */
export type ContextReply<T> =
  | { result: T; approval?: undefined }
  | { approval: WorkflowApprovalPending; result?: undefined };

export interface JarvisContextProvider {
  vaultSearch(
    input: VaultSearchRequest,
    ctx: WorkflowEffectContext,
  ): Promise<ContextReply<VaultEntitySnapshot[]>>;
  vaultGetEntity(
    id: string,
    ctx: WorkflowEffectContext,
  ): Promise<ContextReply<VaultEntitySnapshot | null>>;
  awarenessRecent(
    input: AwarenessRecentRequest,
    ctx: WorkflowEffectContext,
  ): Promise<ContextReply<AwarenessActivitySnapshot[]>>;
  commitmentsList(
    input: CommitmentsListRequest,
    ctx: WorkflowEffectContext,
  ): Promise<ContextReply<CommitmentSnapshot[]>>;
}

/**
 * 200 with the original bare payload, or 202 with the pending approval. Status
 * carries the distinction so the success shape never changes.
 */
function settle<T>(reply: ContextReply<T>): Response {
  return reply.approval ? json({ approval: reply.approval }, 202) : json(reply.result);
}

export interface JarvisContextRouteDeps {
  contextProvider?: JarvisContextProvider;
}

function readOptionalNonNegInt(
  raw: Record<string, unknown>,
  key: string,
): number | undefined | "invalid" {
  if (raw[key] === undefined) return undefined;
  const v = raw[key];
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return "invalid";
  return Math.floor(v);
}

export function createJarvisContextVaultSearchRoute(
  deps: JarvisContextRouteDeps,
): RouteHandler {
  return async (ctx: RouteContext) => {
    if (!deps.contextProvider) return err("jarvis context not configured", 503);
    const raw = await parseJsonObject(ctx);
    if (raw instanceof Response) return raw;
    const out: VaultSearchRequest = {};
    if (raw.query !== undefined) {
      if (typeof raw.query !== "string") return err("query must be a string", 400);
      out.query = raw.query;
    }
    if (raw.type !== undefined) {
      if (typeof raw.type !== "string" || !VAULT_TYPES.has(raw.type)) {
        return err(
          `type must be one of ${Array.from(VAULT_TYPES).join(", ")}`,
          400,
        );
      }
      out.type = raw.type;
    }
    const limit = readOptionalNonNegInt(raw, "limit");
    if (limit === "invalid") return err("limit must be a non-negative number", 400);
    if (limit !== undefined) out.limit = limit;
    return settle(await deps.contextProvider.vaultSearch(out, workflowEffectContext(ctx)));
  };
}

export function createJarvisContextVaultGetEntityRoute(
  deps: JarvisContextRouteDeps,
): RouteHandler {
  return async (ctx: RouteContext) => {
    if (!deps.contextProvider) return err("jarvis context not configured", 503);
    const raw = await parseJsonObject(ctx);
    if (raw instanceof Response) return raw;
    if (typeof raw.id !== "string" || raw.id.length === 0) {
      return err("id is required", 400);
    }
    return settle(await deps.contextProvider.vaultGetEntity(raw.id, workflowEffectContext(ctx)));
  };
}

export function createJarvisContextAwarenessRecentRoute(
  deps: JarvisContextRouteDeps,
): RouteHandler {
  return async (ctx: RouteContext) => {
    if (!deps.contextProvider) return err("jarvis context not configured", 503);
    const raw = await parseJsonObject(ctx);
    if (raw instanceof Response) return raw;
    const out: AwarenessRecentRequest = {};
    const limit = readOptionalNonNegInt(raw, "limit");
    if (limit === "invalid") return err("limit must be a non-negative number", 400);
    if (limit !== undefined) out.limit = limit;
    const since = readOptionalNonNegInt(raw, "since");
    if (since === "invalid") return err("since must be a non-negative number", 400);
    if (since !== undefined) out.since = since;
    return settle(await deps.contextProvider.awarenessRecent(out, workflowEffectContext(ctx)));
  };
}

export function createJarvisContextCommitmentsListRoute(
  deps: JarvisContextRouteDeps,
): RouteHandler {
  return async (ctx: RouteContext) => {
    if (!deps.contextProvider) return err("jarvis context not configured", 503);
    const raw = await parseJsonObject(ctx);
    if (raw instanceof Response) return raw;
    const out: CommitmentsListRequest = {};
    if (raw.status !== undefined) {
      if (typeof raw.status !== "string" || !COMMITMENT_STATUSES.has(raw.status)) {
        return err(
          `status must be one of ${Array.from(COMMITMENT_STATUSES).join(", ")}`,
          400,
        );
      }
      out.status = raw.status;
    }
    const limit = readOptionalNonNegInt(raw, "limit");
    if (limit === "invalid") return err("limit must be a non-negative number", 400);
    if (limit !== undefined) out.limit = limit;
    return settle(await deps.contextProvider.commitmentsList(out, workflowEffectContext(ctx)));
  };
}

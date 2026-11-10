/**
 * `/v1/store-entries` endpoints. Backs the engine's `context.store.put/get/delete`
 * via `engine/src/lib/piece-context/store.ts`.
 *
 * Upstream PUT semantics: returns the upserted `StoreEntry` row; we do the
 * same. GET 404 maps to the engine returning null. DELETE returns null on
 * either branch.
 *
 * Scoping: the engine prefixes keys with `flow_<flowId>/` for FLOW scope
 * (`testflow_<flowId>/` for a trigger's test run) before the call, so the
 * prefixed key is what arrives. Entries are stored per project (the token's
 * claim). The flow part is only a name the engine chose, so a piece could
 * write any key it likes, another flow's prefix included: such a key is
 * refused unless it names the flow this token's run belongs to. Every other
 * key is PROJECT scope, shared by the project's flows as upstream intends.
 */

import {
  StoreInvalidKeyError,
  StoreLimitError,
  deleteStoreEntry,
  getStoreEntry,
  putStoreEntry,
} from "../../db/repos/store-entry";
import { json, err, type RouteContext, type RouteHandler } from "./shared";
import { flowOfClaims } from "./run-flow";

/** A FLOW-scoped key as the engine writes it: `[test]flow_<flowId>/<key>`. */
const FLOW_SCOPED_KEY = /^(?:test)?flow_([^/]*)\//;

/** Why this token may not use `key`, or null: a FLOW-scoped key of another flow (or of none). */
function foreignFlowKey(ctx: RouteContext, key: string): Response | null {
  const scoped = FLOW_SCOPED_KEY.exec(key);
  if (!scoped) return null;
  return scoped[1] === flowOfClaims(ctx.claims) ? null : err("store key belongs to another workflow", 403);
}

export const getStoreEntryRoute: RouteHandler = async (ctx: RouteContext) => {
  const url = new URL(ctx.req.url);
  const key = url.searchParams.get("key");
  if (!key) return err("missing 'key' query param", 400);
  const foreign = foreignFlowKey(ctx, key);
  if (foreign) return foreign;
  try {
    const entry = getStoreEntry(ctx.claims.projectId, key);
    if (!entry) return new Response("null", { status: 404, headers: { "Content-Type": "application/json" } });
    return json(entry);
  } catch (e) {
    if (e instanceof StoreInvalidKeyError) return err(e.message, 400);
    throw e;
  }
};

export const putStoreEntryRoute: RouteHandler = async (ctx: RouteContext) => {
  let body: { key?: string; value?: unknown };
  try {
    body = (await ctx.req.json()) as { key?: string; value?: unknown };
  } catch {
    return err("invalid JSON body", 400);
  }
  if (typeof body.key !== "string") return err("body.key must be a string", 400);
  const foreign = foreignFlowKey(ctx, body.key);
  if (foreign) return foreign;
  try {
    const entry = putStoreEntry(ctx.claims.projectId, body.key, body.value);
    return json(entry, 201);
  } catch (e) {
    if (e instanceof StoreInvalidKeyError) return err(e.message, 400);
    if (e instanceof StoreLimitError) return err(e.message, 413);
    throw e;
  }
};

export const deleteStoreEntryRoute: RouteHandler = async (ctx: RouteContext) => {
  const url = new URL(ctx.req.url);
  const key = url.searchParams.get("key");
  if (!key) return err("missing 'key' query param", 400);
  const foreign = foreignFlowKey(ctx, key);
  if (foreign) return foreign;
  try {
    deleteStoreEntry(ctx.claims.projectId, key);
    return new Response("null", { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (e) {
    if (e instanceof StoreInvalidKeyError) return err(e.message, 400);
    throw e;
  }
};

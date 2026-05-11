/**
 * `/v1/store-entries` endpoints. Backs the engine's `context.store.put/get/delete`
 * via `engine/src/lib/piece-context/store.ts`.
 *
 * Upstream PUT semantics: returns the upserted `StoreEntry` row; we do the
 * same. GET 404 maps to the engine returning null. DELETE returns null on
 * either branch.
 *
 * Scoping: the engine prefixes keys with `flow_<flowId>/` for FLOW scope before
 * the call, so we don't need to know the difference here -- the prefixed key
 * is what arrives.
 */

import {
  StoreInvalidKeyError,
  StoreLimitError,
  deleteStoreEntry,
  getStoreEntry,
  putStoreEntry,
} from "../../db/repos/store-entry";
import { json, err, type RouteContext, type RouteHandler } from "./shared";

export const getStoreEntryRoute: RouteHandler = async (ctx: RouteContext) => {
  const url = new URL(ctx.req.url);
  const key = url.searchParams.get("key");
  if (!key) return err("missing 'key' query param", 400);
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
  try {
    deleteStoreEntry(ctx.claims.projectId, key);
    return new Response("null", { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (e) {
    if (e instanceof StoreInvalidKeyError) return err(e.message, 400);
    throw e;
  }
};

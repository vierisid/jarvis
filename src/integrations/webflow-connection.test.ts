import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { JarvisConfig } from "../config/types";
import { readWebflowConnection, webflowStatus } from "./webflow-connection";
import { webflowOptions } from "./webflow-options";
import { webflowNeedsReconnect } from "./webflow-access";
import { JarvisWebflowConnectionSource } from "../workflows/credentials/webflow-source";
import { managedConnectionMisuse } from "../workflows/credentials/adapter";
import {
  resolveGovernedPieceAction,
  tracksPieceCompletion,
} from "../workflows/runtime/piece-effects";
let dir: string, config: JarvisConfig;
const site = "a".repeat(24),
  collection = "b".repeat(24),
  piece = "@activepieces/piece-webflow";
const doc = () => ({
  version: 1,
  provider: "webflow",
  status: "connected",
  generation: randomUUID(),
  access_token: "PRIVATE-TOKEN",
  account: { id: "c".repeat(24), label: "owner@example.test" },
  workspaces: [{ id: site, name: "Sandbox" }],
  connected_at: new Date().toISOString(),
});
/** Webflow's /token/authorized_by for the connected user. */
const accepted = (calls: string[] = []) =>
  (async (url: unknown) => {
    calls.push(String(url));
    return Response.json({ id: "c".repeat(24), email: "owner@example.test" });
  }) as unknown as typeof fetch;
const refused = (status: number, calls: string[] = []) =>
  (async (url: unknown) => {
    calls.push(String(url));
    return new Response("{}", { status });
  }) as unknown as typeof fetch;
const write = (v: unknown) =>
  writeFileSync(join(dir, "connections/webflow.json"), JSON.stringify(v));
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "webflow-unit-"));
  mkdirSync(join(dir, "connections"));
  config = {
    daemon: { data_dir: dir },
    usejarvis_integrations: { page_url: "https://app.usejarvis.dev/account" },
  } as JarvisConfig;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
test("status omits tokens, invalid documents fail closed, reconnect and disconnect invalidate identity", async () => {
  const c = doc();
  write(c);
  const source = new JarvisWebflowConnectionSource(config, accepted());
  expect(webflowStatus(config)).toMatchObject({
    connected: true,
    reconnect: false,
    connect_url: "https://app.usejarvis.dev/account?integration=webflow",
  });
  expect(JSON.stringify(webflowStatus(config))).not.toContain("PRIVATE");
  const key = source.identity("jarvis:webflow");
  expect((await source.resolve("jarvis:webflow"))?.value).toEqual({
    access_token: "PRIVATE-TOKEN",
    token_type: "Bearer",
    jarvis_managed: "webflow",
    webflow_site_ids: [site],
  });
  expect(await source.resolve("jarvis:github")).toBeNull();
  write({ ...c, workspaces: [{ id: "d".repeat(24), name: "Other" }] });
  expect(source.identity("jarvis:webflow")).not.toBe(key);
  for (const bad of [
    { ...c, status: "disconnected" },
    { ...c, provider: "other" },
    { ...c, workspaces: [] },
    { ...c, workspaces: [...c.workspaces, ...c.workspaces] },
    { ...c, account: { id: "bad", label: "x" } },
    { ...c, connected_at: "bad" },
    { ...c, access_token: "" },
  ]) {
    write(bad);
    expect(readWebflowConnection(dir)).toBeNull();
    expect(await source.resolve("jarvis:webflow")).toBeNull();
  }
  writeFileSync(join(dir, "connections/webflow.json"), "x".repeat(65537));
  expect(readWebflowConnection(dir)).toBeNull();
});
test("only four CMS actions may resolve the credential, never a trigger or arbitrary HTTP node", () => {
  const source = new JarvisWebflowConnectionSource(config);
  for (const action of [
    "get_collection_item",
    "find_collection_item",
    "create_collection_item",
    "update_collection_item",
  ])
    expect(
      managedConnectionMisuse(source, piece, "settings.input.auth", {
        actionName: action,
      }),
    ).toBeNull();
  for (const action of [
    "delete_collection_item",
    "publish_collection_item",
    "custom_api_call",
    "refund_order",
    "list_sites",
  ])
    expect(
      managedConnectionMisuse(source, piece, "settings.input.auth", {
        actionName: action,
      }),
    ).not.toBeNull();
  expect(
    managedConnectionMisuse(source, piece, "settings.input.auth", {
      triggerName: "new_form_submission",
    }),
  ).not.toBeNull();
  expect(
    managedConnectionMisuse(
      source,
      "@activepieces/piece-http",
      "settings.input.auth",
      {},
    ),
  ).not.toBeNull();
  expect(
    managedConnectionMisuse(source, piece, "settings.input.url", {
      actionName: "get_collection_item",
    }),
  ).not.toBeNull();
});
test("picker validates site and generation before fetch and never returns stale-account choices", async () => {
  const c = doc();
  write(c);
  let calls = 0;
  const request = (async () => {
    calls++;
    return Response.json({
      collections: [{ id: collection, displayName: "Articles" }],
    });
  }) as unknown as typeof fetch;
  const q = new URLSearchParams({ site, generation: c.generation });
  expect(await webflowOptions(config, q, request)).toEqual({
    collections: [{ id: collection, name: "Articles" }],
    generation: c.generation,
  });
  expect(
    JSON.stringify(await webflowOptions(config, q, request)),
  ).not.toContain("PRIVATE");
  calls = 0;
  for (const query of [
    new URLSearchParams({ site, generation: "old" }),
    new URLSearchParams({ site: "d".repeat(24), generation: c.generation }),
  ])
    await expect(webflowOptions(config, query, request)).rejects.toThrow();
  expect(calls).toBe(0);
  await expect(
    webflowOptions(config, q, (async () => {
      write({ ...c, status: "disconnected" });
      return Response.json({ collections: [] });
    }) as unknown as typeof fetch),
  ).rejects.toThrow("changed");
});
test("a grant Webflow refuses shows reconnect until hosting delivers another one", async () => {
  const c = doc();
  write(c);
  const calls: string[] = [];
  // Throttling, an outage or a different account never asks for a reconnect.
  for (const request of [refused(429), refused(503)])
    await expect(
      new JarvisWebflowConnectionSource(config, request).resolve("jarvis:webflow"),
    ).rejects.toThrow();
  await expect(
    new JarvisWebflowConnectionSource(config, (async () =>
      Response.json({ id: "e".repeat(24), email: "x@example.test" })) as unknown as typeof fetch,
    ).resolve("jarvis:webflow"),
  ).rejects.toThrow("account changed");
  expect(webflowStatus(config)).toMatchObject({ connected: true, reconnect: false });
  const source = new JarvisWebflowConnectionSource(config, refused(401, calls));
  await expect(source.resolve("jarvis:webflow")).rejects.toThrow("Reconnect Webflow");
  expect(calls).toEqual(["https://api.webflow.com/v2/token/authorized_by"]);
  expect(webflowStatus(config)).toMatchObject({ connected: false, reconnect: true, account: c.account });
  expect(source.identity("jarvis:webflow")).toBeNull();
  // Marked: no further request until a new grant arrives.
  await expect(source.resolve("jarvis:webflow")).rejects.toThrow("Reconnect Webflow");
  expect(calls).toHaveLength(1);
  write({ ...c, generation: randomUUID(), access_token: "PRIVATE-NEW" });
  expect(webflowStatus(config)).toMatchObject({ connected: true, reconnect: false });
  const ok: string[] = [];
  const fresh = new JarvisWebflowConnectionSource(config, accepted(ok));
  expect(fresh.identity("jarvis:webflow")).not.toBeNull();
  expect((await fresh.resolve("jarvis:webflow"))?.value).toMatchObject({ access_token: "PRIVATE-NEW" });
  // An accepted grant is checked once for the steps of a run, not per step.
  await fresh.resolve("jarvis:webflow");
  expect(ok).toHaveLength(1);
});
test("a 401 in the collection picker marks the grant for reconnect; a 403 does not", async () => {
  const c = doc();
  write(c);
  const q = new URLSearchParams({ site, generation: c.generation });
  await expect(webflowOptions(config, q, refused(403))).rejects.toThrow("site permissions");
  expect(webflowNeedsReconnect(config, readWebflowConnection(dir)!)).toBe(false);
  await expect(webflowOptions(config, q, refused(401))).rejects.toThrow("Reconnect Webflow");
  expect(webflowStatus(config)).toMatchObject({ connected: false, reconnect: true });
});
test("actions have conservative effects; every change needs a completion receipt", () => {
  for (const action of ["get_collection_item", "find_collection_item", "find_order", "list_sites", "list_collections"]) {
    expect(resolveGovernedPieceAction(piece, action)?.category).toBe(
      "read_data",
    );
    expect(tracksPieceCompletion(piece, action)).toBe(false);
  }
  // Managed writes stay drafts: a write, not a message.
  for (const action of ["create_collection_item", "update_collection_item", "unfulfill_order"]) {
    expect(resolveGovernedPieceAction(piece, action)?.category).toBe(
      "write_data",
    );
    expect(tracksPieceCompletion(piece, action)).toBe(true);
  }
  for (const [action, category] of [
    ["publish_collection_item", "send_message"],
    ["delete_collection_item", "delete_data"],
    ["custom_api_call", "modify_settings"],
    ["refund_order", "make_payment"],
    // Blind (no input): the worst case, narrowed below.
    ["fulfill_order", "modify_settings"],
  ] as const) {
    expect(resolveGovernedPieceAction(piece, action)?.category).toBe(category);
    // An uncertain failure is never replayed, a refund least of all.
    expect(tracksPieceCompletion(piece, action)).toBe(true);
  }
  // Fulfilling emails the customer only with the email option on.
  const fulfill = (input: unknown) =>
    resolveGovernedPieceAction(piece, "fulfill_order", input)?.category;
  expect(fulfill({ site_id: site, order_id: "o1", send_order_fulfilled_email: true })).toBe("send_email");
  expect(fulfill({ site_id: site, order_id: "o1", send_order_fulfilled_email: "{{trigger.email}}" })).toBe("send_email");
  expect(fulfill({ site_id: site, order_id: "o1", send_order_fulfilled_email: false })).toBe("write_data");
  expect(fulfill({ site_id: site, order_id: "o1" })).toBe("write_data");
  expect(resolveGovernedPieceAction(piece, "fulfill_order", { order_id: "o1" })?.adapter.targetProps).toContain("order_id");
});

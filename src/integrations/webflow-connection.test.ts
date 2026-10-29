import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { JarvisConfig } from "../config/types";
import { readWebflowConnection, webflowStatus } from "./webflow-connection";
import { webflowOptions } from "./webflow-options";
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
  const source = new JarvisWebflowConnectionSource(dir);
  expect(webflowStatus(config)).toMatchObject({
    connected: true,
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
  const source = new JarvisWebflowConnectionSource(dir);
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
test("actions have conservative effects; only writes need completion receipts", () => {
  for (const action of ["get_collection_item", "find_collection_item"]) {
    expect(resolveGovernedPieceAction(piece, action)?.category).toBe(
      "read_data",
    );
    expect(tracksPieceCompletion(piece, action)).toBe(false);
  }
  for (const action of ["create_collection_item", "update_collection_item"]) {
    expect(resolveGovernedPieceAction(piece, action)?.category).toBe(
      "send_message",
    );
    expect(tracksPieceCompletion(piece, action)).toBe(true);
  }
  expect(resolveGovernedPieceAction(piece, "refund_order")?.category).toBe(
    "make_payment",
  );
});

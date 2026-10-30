import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHmac } from "node:crypto";
import type { JarvisConfig } from "../config/types";
import { readDropboxConnection, dropboxStatus } from "./dropbox-connection";
import {
  freshDropboxConnection,
  dropboxNeedsReconnect,
} from "./dropbox-refresh";
import { JarvisDropboxConnectionSource } from "../workflows/credentials/dropbox-source";
import { managedConnectionMisuse } from "../workflows/credentials/adapter";
import {
  MANAGED_PIECE_ADAPTERS,
  resolveGovernedPieceAction,
} from "../workflows/runtime/piece-effects";
import { MANAGED_DROPBOX_ACTIONS } from "../workflows/runtime/managed-dropbox";
/** Every action of the pinned @activepieces/piece-dropbox 0.9.2 bundle, read from
 * its `actions()` (custom_api_call is added by the framework and stays unmapped).
 * The engine test checks the installed package against the adapter too. */
const DROPBOX_092_ACTIONS = [
  "search_dropbox", "create_new_dropbox_text_file", "upload_dropbox_file", "downloadFile",
  "get_dropbox_file_link", "delete_dropbox_file", "move_dropbox_file", "copy_dropbox_file",
  "create_new_dropbox_folder", "delete_dropbox_folder", "move_dropbox_folder", "copy_dropbox_folder",
  "list_dropbox_folder", "get_dropbox_file_metadata", "list_dropbox_file_revisions", "restore_dropbox_file",
  "create_dropbox_copy_reference", "save_dropbox_copy_reference", "lock_dropbox_file", "unlock_dropbox_file",
  "get_dropbox_file_lock", "create_dropbox_upload_link", "download_dropbox_folder_as_zip",
  "get_dropbox_file_preview", "get_dropbox_file_thumbnail", "get_dropbox_thumbnails_batch",
  "save_url_to_dropbox", "get_dropbox_save_url_status", "start_dropbox_copy_batch",
  "get_dropbox_copy_batch_status", "start_dropbox_move_batch", "get_dropbox_move_batch_status",
  "start_dropbox_delete_batch", "get_dropbox_delete_batch_status", "start_dropbox_create_folder_batch",
  "get_dropbox_create_folder_batch_status", "copy_dropbox_entry", "move_dropbox_entry", "delete_dropbox_entry",
];
let dir: string, config: JarvisConfig;
const doc = () => ({
  version: 1 as const,
  provider: "dropbox" as const,
  status: "connected" as const,
  generation: randomUUID(),
  access_token: "OLD_ACCESS",
  refresh_token: "PRIVATE_REFRESH",
  expires_at: new Date(0).toISOString(),
  account: { id: "dbid:1", label: "owner@example.test" },
  workspaces: [{ id: "123", name: "Dropbox home" }],
  settings: { home_namespace_id: "123" },
  connected_at: new Date().toISOString(),
  refresh: {
    url: "https://app.usejarvis.dev/api/integrations/dropbox/refresh",
    instance_id: randomUUID(),
    secret: "a".repeat(64),
  },
});
const write = (v: unknown) =>
  writeFileSync(join(dir, "connections/dropbox.json"), JSON.stringify(v));
const success = () =>
  Response.json({
    access_token: "NEW_ACCESS",
    expires_at: new Date(Date.now() + 3600000).toISOString(),
  });
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dropbox-unit-"));
  mkdirSync(join(dir, "connections"));
  config = {
    daemon: { data_dir: dir },
    usejarvis_integrations: { page_url: "https://app.usejarvis.dev/account" },
  } as JarvisConfig;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
test("status is secret-free, malformed grants fail closed and only qualified actions can use the credential", () => {
  const c = doc();
  write(c);
  const source = new JarvisDropboxConnectionSource(config);
  expect(dropboxStatus(config)).toMatchObject({
    connected: true,
    connect_url: "https://app.usejarvis.dev/account?integration=dropbox",
  });
  expect(JSON.stringify(dropboxStatus(config))).not.toMatch(
    /OLD_ACCESS|PRIVATE_REFRESH|aaaaaaa/,
  );
  for (const action of ["custom_api_call", "delete_dropbox_file", "new_folder"])
    expect(
      managedConnectionMisuse(
        source,
        source.pieceNames[0]!,
        "settings.input.auth",
        { actionName: action },
      ),
    ).not.toBeNull();
  expect(
    managedConnectionMisuse(
      source,
      source.pieceNames[0]!,
      "settings.input.auth",
      { actionName: "search_dropbox" },
    ),
  ).toBeNull();
  expect(
    managedConnectionMisuse(
      source,
      "@activepieces/piece-http",
      "settings.input.auth",
      {},
    ),
  ).not.toBeNull();
  for (const bad of [
    { ...c, refresh: null },
    { ...c, expires_at: "invalid" },
    { ...c, settings: { home_namespace_id: "evil" } },
    { ...c, provider: "other" },
  ]) {
    write(bad);
    expect(readDropboxConnection(dir)).toBeNull();
  }
  writeFileSync(join(dir, "connections/dropbox.json"), "x".repeat(65537));
  expect(readDropboxConnection(dir)).toBeNull();
});
test("concurrent renewal signs exact bytes, caches atomically and preserves grant identity across restart", async () => {
  const c = doc();
  write(c);
  let calls = 0;
  const request = (async (url: string, init: RequestInit) => {
    calls++;
    expect(url).toBe(c.refresh.url);
    expect(init.redirect).toBe("error");
    expect(new Headers(init.headers).get("x-jarvis-signature")).toBe(
      createHmac("sha256", c.refresh.secret)
        .update(String(init.body))
        .digest("hex"),
    );
    expect(JSON.parse(String(init.body)).refreshToken).toBe("PRIVATE_REFRESH");
    await Bun.sleep(5);
    return success();
  }) as unknown as typeof fetch;
  const source = new JarvisDropboxConnectionSource(config, request),
    identity = source.identity("jarvis:dropbox");
  const results = await Promise.all(
    Array.from({ length: 8 }, () => source.resolve("jarvis:dropbox")),
  );
  expect(calls).toBe(1);
  expect(results.every((x) => x?.value.access_token === "NEW_ACCESS")).toBe(
    true,
  );
  expect(source.identity("jarvis:dropbox")).toBe(identity);
  expect(readFileSync(join(dir, "connections/dropbox.json"), "utf8")).toBe(
    JSON.stringify(c),
  );
  expect(
    statSync(join(dir, "connections/dropbox-access.json")).mode & 0o777,
  ).toBe(0o600);
  expect(
    (
      await new JarvisDropboxConnectionSource(config, request).resolve(
        "jarvis:dropbox",
      )
    )?.value.refresh_token,
  ).toBe("");
  expect(calls).toBe(1);
  write({ ...c, status: "disconnected" });
  expect(await source.resolve("jarvis:dropbox")).toBeNull();
  expect(source.identity("jarvis:dropbox")).toBeNull();
});
test("a disconnect or reconnect during renewal cannot resurrect the previous grant", async () => {
  const c = doc();
  write(c);
  await expect(
    freshDropboxConnection(config, (async () => {
      write({ ...c, status: "disconnected" });
      return success();
    }) as unknown as typeof fetch),
  ).rejects.toThrow("changed");
  write(c);
  await expect(
    freshDropboxConnection(config, (async () => {
      write(doc());
      return success();
    }) as unknown as typeof fetch),
  ).rejects.toThrow("changed");
});
test("revocation requests reconnect, transient failures preserve the binding, renewal cannot leave hosting origin", async () => {
  const c = doc();
  write(c);
  for (const status of [404, 429, 502, 503]) {
    await expect(
      freshDropboxConnection(config, (async () =>
        Response.json(
          { error: "secret" },
          { status },
        )) as unknown as typeof fetch),
    ).rejects.toThrow("Try again");
    expect(dropboxNeedsReconnect(config, c)).toBe(false);
  }
  await expect(
    freshDropboxConnection(config, (async () =>
      Response.json(
        { reconnect: true },
        { status: 409 },
      )) as unknown as typeof fetch),
  ).rejects.toThrow("Reconnect");
  expect(dropboxNeedsReconnect(config, c)).toBe(true);
  // The origin and the path are each checked on their own: each URL below
  // passes every other rule and fails exactly one of them.
  for (const url of [
    "https://attacker.test/refresh",
    "https://attacker.test/api/integrations/dropbox/refresh",
    "https://app.usejarvis.dev/api/integrations/dropbox/other",
  ]) {
    write({ ...doc(), refresh: { ...c.refresh, url } });
    let calls = 0;
    await expect(
      freshDropboxConnection(config, (async () => {
        calls++;
        return success();
      }) as unknown as typeof fetch),
    ).rejects.toThrow("not configured");
    expect(calls).toBe(0);
  }
});
test("a reconnect that lands while the renewed token is saved is not handed out", async () => {
  const c = doc();
  write(c);
  const original = fs.renameSync;
  const rename = spyOn(fs, "renameSync").mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
    original(from, to);
    // The grant changes after the save; only the check after it can see this.
    if (String(to).endsWith("dropbox-access.json")) write(doc());
  }) as typeof fs.renameSync);
  try {
    await expect(
      freshDropboxConnection(config, (async () => success()) as unknown as typeof fetch),
    ).rejects.toThrow("changed");
    expect(rename).toHaveBeenCalled();
  } finally {
    rename.mockRestore();
  }
});

test("the Dropbox adapter names every action of the pinned bundle, and nothing else", () => {
  const piece = "@activepieces/piece-dropbox";
  const adapter = MANAGED_PIECE_ADAPTERS.find((a) => a.pieceName === piece)!;
  const mapped = Object.values(adapter.categories).flat() as string[];
  expect(DROPBOX_092_ACTIONS).toHaveLength(39);
  expect([...mapped].sort()).toEqual([...DROPBOX_092_ACTIONS].sort());
  expect(resolveGovernedPieceAction(piece, "custom_api_call")).toMatchObject({
    category: "modify_settings",
    known: false,
  });
  // The managed connection's own actions are a subset of the governed table.
  for (const action of MANAGED_DROPBOX_ACTIONS)
    expect(DROPBOX_092_ACTIONS).toContain(action);
});
test("a caller without the step's settings is told about the piece only; with them, a trigger is refused", () => {
  write(doc());
  const source = new JarvisDropboxConnectionSource(config);
  const piece = source.pieceNames[0]!;
  expect(managedConnectionMisuse(source, piece, "settings.input.auth")).toBeNull();
  expect(
    managedConnectionMisuse(source, "@activepieces/piece-http", "settings.input.auth"),
  ).not.toBeNull();
  // A trigger is refused by its triggerName even when it also names an
  // allowed action: the trigger hook runs the piece's own trigger code.
  for (const settings of [
    { triggerName: "new_folder" },
    { triggerName: "new_folder", actionName: "search_dropbox" },
    {},
    null,
    "x",
  ])
    expect(
      managedConnectionMisuse(source, piece, "settings.input.auth", settings),
    ).not.toBeNull();
});
